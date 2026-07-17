import { load } from "cheerio";
import type { CareerDatabase } from "../db/client.js";
import type { FetchedPage } from "./fetch-page.js";
import { fetchPublicPage } from "./fetch-page.js";
import { DisabledSearchProvider, type SearchProvider } from "./search-provider.js";
import { SourceTimestampError, validateSourceTimestamp } from "./source-validation.js";
import type {
  DiscoveryResult,
  DiscoveryBudgets,
  Evidence,
  PersonWithEvidence,
  SourceWarning
} from "./types.js";

const OFFICIAL_PAGE_PATTERN = /(?:^|[\s/_-])(team|people|leadership|leaders|about|company)(?:$|[\s/_-])/i;

type PeopleRepositories = Pick<CareerDatabase, "companies" | "people" | "evidence">;

export type PeopleDiscoveryDependencies = {
  repositories: PeopleRepositories;
  fetchPage?: (url: string) => Promise<FetchedPage>;
  searchProvider?: SearchProvider;
  now?: () => Date;
  elapsedNow?: () => number;
  budgets?: Partial<DiscoveryBudgets>;
};

export interface PeopleDiscoveryService {
  discoverPublicPeople(companyId: string): Promise<DiscoveryResult>;
}

const DEFAULT_DISCOVERY_BUDGETS: DiscoveryBudgets = {
  maxOfficialPagesPerCompany: 5,
  maxSearchResultsPerCompany: 10,
  maxTotalRequestsPerCompany: 16,
  maxElapsedMsPerCompany: 20_000
};

type DiscoveredPerson = {
  companyId: string;
  name: string;
  role: string;
  sourceUrl: string;
  sourceTitle: string;
  checkedAt: string;
  confidence: number;
  fact: string;
  publicProfileUrl?: string;
};

type ParsedPeoplePage = {
  people: DiscoveredPerson[];
  recognized: boolean;
  warnings: SourceWarning[];
};

const FIELD_LIMITS = {
  name: { characters: 160, bytes: 320 },
  role: { characters: 240, bytes: 480 },
  fact: { characters: 320, bytes: 640 },
  title: { characters: 300, bytes: 600 },
  url: { characters: 2_048, bytes: 4_096 }
} as const;

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function withinFieldLimit(value: string, limit: { characters: number; bytes: number }): boolean {
  return value.length <= limit.characters && Buffer.byteLength(value, "utf8") <= limit.bytes;
}

function invalidFieldWarning(sourceUrl: string, field: string): SourceWarning {
  const limit = field === "name"
    ? FIELD_LIMITS.name
    : field === "role"
      ? FIELD_LIMITS.role
      : field === "evidence fact"
        ? FIELD_LIMITS.fact
        : field === "source title"
          ? FIELD_LIMITS.title
          : FIELD_LIMITS.url;
  return {
    code: "invalid-data",
    sourceUrl,
    message: `Skipped public person record because ${field} exceeds ${limit.characters} characters or ${limit.bytes} UTF-8 bytes`
  };
}

function normalizedHttpUrl(value: string, baseUrl?: string): string | undefined {
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function isLinkedInUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase().replace(/\.+$/, "");
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function explicitLinkedInUrl(
  $: ReturnType<typeof load>,
  card: Parameters<ReturnType<typeof load>>[0],
  pageUrl: string
): string | undefined {
  for (const anchor of $(card).find("a[href]").toArray()) {
    const href = $(anchor).attr("href");
    const normalized = href === undefined ? undefined : normalizedHttpUrl(href, pageUrl);
    if (normalized !== undefined && isLinkedInUrl(normalized)) {
      return normalized;
    }
  }
  return undefined;
}

function parsePeople(
  page: FetchedPage,
  companyId: string,
  confidence: number,
  allowLinkedInProfile: boolean,
  now: Date
): ParsedPeoplePage {
  const freshness = validateSourceTimestamp(page.checkedAt, now, "Public people source");
  const checkedAt = freshness.checkedAt;
  const $ = load(page.html);
  const parsed: DiscoveredPerson[] = [];
  const warnings: SourceWarning[] = [];
  if (freshness.stale) {
    warnings.push({
      code: "stale-source",
      sourceUrl: page.url,
      message: "Public people source is older than the 30-day freshness policy"
    });
  }
  const cards = $(
    [
      "[data-team-member]",
      "article.team-member",
      "article.person-card",
      "li.team-member",
      "li.person-card",
      ".leadership-card",
      ".leader-card"
    ].join(", ")
  ).toArray();
  for (const card of cards) {
    const name = normalizedText($(card).find(
      "[data-person-name], .person-name, .member-name, .name, h2, h3, h4"
    ).first().text());
    const role = normalizedText($(card).find(
      "[data-person-role], .person-role, .member-role, .job-title, .position, .role, p"
    ).first().text());
    if (name === "" || role === "") {
      continue;
    }
    if (!withinFieldLimit(name, FIELD_LIMITS.name)) {
      warnings.push(invalidFieldWarning(page.url, "name"));
      continue;
    }
    if (!withinFieldLimit(role, FIELD_LIMITS.role)) {
      warnings.push(invalidFieldWarning(page.url, "role"));
      continue;
    }
    if (!withinFieldLimit(page.title, FIELD_LIMITS.title)) {
      warnings.push(invalidFieldWarning(page.url, "source title"));
      continue;
    }
    if (!withinFieldLimit(page.url, FIELD_LIMITS.url)) {
      warnings.push(invalidFieldWarning(page.url.slice(0, FIELD_LIMITS.url.characters), "source URL"));
      continue;
    }
    const publicProfileUrl = allowLinkedInProfile
      ? explicitLinkedInUrl($, card, page.url)
      : undefined;
    if (
      publicProfileUrl !== undefined
      && !withinFieldLimit(publicProfileUrl, FIELD_LIMITS.url)
    ) {
      warnings.push(invalidFieldWarning(page.url, "profile URL"));
      continue;
    }
    const fact = `${name} — ${role}`;
    if (!withinFieldLimit(fact, FIELD_LIMITS.fact)) {
      warnings.push(invalidFieldWarning(page.url, "evidence fact"));
      continue;
    }
    parsed.push({
      companyId,
      name,
      role,
      sourceUrl: page.url,
      sourceTitle: normalizedText(page.title) || "Official company page",
      checkedAt,
      confidence,
      fact,
      ...(publicProfileUrl === undefined ? {} : { publicProfileUrl })
    });
  }
  return { people: parsed, recognized: cards.length > 0, warnings };
}

function officialPageUrls(page: FetchedPage): {
  urls: string[];
  warnings: SourceWarning[];
} {
  const pageUrl = new URL(page.url);
  const $ = load(page.html);
  const urls = new Set<string>();
  const warnings: SourceWarning[] = [];
  for (const anchor of $("a[href]").toArray()) {
    const href = $(anchor).attr("href");
    if (href === undefined) {
      continue;
    }
    const url = normalizedHttpUrl(href, page.url);
    if (url === undefined) {
      continue;
    }
    const parsed = new URL(url);
    if (parsed.origin !== pageUrl.origin || isLinkedInUrl(url)) {
      continue;
    }
    const label = `${parsed.pathname} ${normalizedText($(anchor).text())}`;
    if (OFFICIAL_PAGE_PATTERN.test(label)) {
      if (!withinFieldLimit(url, FIELD_LIMITS.url)) {
        warnings.push({
          code: "invalid-data",
          sourceUrl: page.url,
          message: "Official people candidate URL exceeds 2048 characters or 4096 UTF-8 bytes"
        });
        continue;
      }
      urls.add(url);
    }
  }
  return {
    urls: Array.from(urls).sort((left, right) => left.localeCompare(right, "en")),
    warnings
  };
}

function deduplicationKey(person: Pick<DiscoveredPerson, "name" | "role">): string {
  return `${person.name.toLocaleLowerCase("en")}\u0000${person.role.toLocaleLowerCase("en")}`;
}

function warning(sourceUrl: string, error: unknown): SourceWarning {
  return {
    ...(error instanceof SourceTimestampError ? { code: error.code } : {}),
    sourceUrl,
    message: error instanceof Error ? error.message : "Public source request failed"
  };
}

function evidenceFor(person: DiscoveredPerson, id: string): Evidence {
  return {
    id,
    url: person.sourceUrl,
    sourceUrl: person.sourceUrl,
    title: person.sourceTitle,
    fact: person.fact,
    checkedAt: person.checkedAt,
    confidence: person.confidence
  };
}

export function createPeopleDiscovery(
  dependencies: PeopleDiscoveryDependencies
): PeopleDiscoveryService {
  const fetchPage = dependencies.fetchPage ?? fetchPublicPage;
  const searchProvider = dependencies.searchProvider ?? new DisabledSearchProvider();
  const now = dependencies.now ?? (() => new Date());
  const elapsedNow = dependencies.elapsedNow ?? (() => performance.now());
  const budgets = { ...DEFAULT_DISCOVERY_BUDGETS, ...dependencies.budgets };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  const discoverPublicPeople = async (companyId: string): Promise<DiscoveryResult> => {
    const company = dependencies.repositories.companies.get(companyId);
    if (company === undefined) {
      throw new Error(`Company ${companyId} was not found`);
    }
    if (company.websiteUrl === null) {
      throw new Error(`Company ${companyId} has no stored official website`);
    }
    const websiteUrl = normalizedHttpUrl(company.websiteUrl);
    if (websiteUrl === undefined) {
      throw new Error(`Company ${companyId} has an invalid stored official website`);
    }

    const warnings: SourceWarning[] = [];
    const discovered: DiscoveredPerson[] = [];
    const checkedTimes: string[] = [];
    const fetchedUrls = new Set<string>();
    const startedAt = elapsedNow();
    let totalRequests = 0;
    let elapsedBudgetReported = false;
    let requestBudgetReported = false;
    const addElapsedWarning = (): boolean => {
      if (elapsedNow() - startedAt <= budgets.maxElapsedMsPerCompany) {
        return true;
      }
      if (!elapsedBudgetReported) {
        warnings.push({
          code: "budget-exhausted",
          sourceUrl: websiteUrl,
          message: `People discovery elapsed-time budget of ${budgets.maxElapsedMsPerCompany}ms was exhausted`
        });
        elapsedBudgetReported = true;
      }
      return false;
    };
    const beginRequest = (): boolean => {
      if (!addElapsedWarning()) {
        return false;
      }
      if (totalRequests >= budgets.maxTotalRequestsPerCompany) {
        if (!requestBudgetReported) {
          warnings.push({
            code: "budget-exhausted",
            sourceUrl: websiteUrl,
            message: `People discovery total request budget of ${budgets.maxTotalRequestsPerCompany} was exhausted`
          });
          requestBudgetReported = true;
        }
        return false;
      }
      totalRequests += 1;
      return true;
    };
    let homePage: FetchedPage | undefined;
    let traversalWithinTime = true;
    try {
      if (!beginRequest()) {
        return {
          people: [],
          evidence: [],
          checkedAt: now().toISOString(),
          coverage: searchProvider.coverage,
          warnings
        };
      }
      homePage = await fetchPage(websiteUrl);
      fetchedUrls.add(homePage.url);
      const parsedHome = parsePeople(homePage, companyId, 0.95, true, now());
      checkedTimes.push(homePage.checkedAt);
      discovered.push(...parsedHome.people);
      warnings.push(...parsedHome.warnings);
      if (
        OFFICIAL_PAGE_PATTERN.test(new URL(homePage.url).pathname)
        && !parsedHome.recognized
      ) {
        warnings.push({
          code: "source-changed",
          sourceUrl: homePage.url,
          message: "Official people page has no recognized team or leadership structure"
        });
      }
      traversalWithinTime = addElapsedWarning();
    } catch (error) {
      warnings.push(warning(websiteUrl, error));
    }

    const officialCandidates = homePage === undefined || !traversalWithinTime
      ? { urls: [], warnings: [] }
      : officialPageUrls(homePage);
    warnings.push(...officialCandidates.warnings);
    const allOfficialUrls = officialCandidates.urls;
    const officialUrls = allOfficialUrls.slice(0, budgets.maxOfficialPagesPerCompany);
    if (allOfficialUrls.length > officialUrls.length) {
      warnings.push({
        code: "budget-exhausted",
        sourceUrl: websiteUrl,
        message: `Official people page budget truncated ${allOfficialUrls.length} candidates to ${officialUrls.length}`
      });
    }
    for (const url of officialUrls) {
      if (fetchedUrls.has(url)) {
        continue;
      }
      if (!beginRequest()) {
        break;
      }
      try {
        const page = await fetchPage(url);
        fetchedUrls.add(page.url);
        const parsedPage = parsePeople(page, companyId, 0.95, true, now());
        checkedTimes.push(page.checkedAt);
        discovered.push(...parsedPage.people);
        warnings.push(...parsedPage.warnings);
        if (!parsedPage.recognized) {
          warnings.push({
            code: "source-changed",
            sourceUrl: page.url,
            message: "Official people page has no recognized team or leadership structure"
          });
        }
        if (!addElapsedWarning()) {
          break;
        }
      } catch (error) {
        warnings.push(warning(url, error));
      }
    }

    if (searchProvider.coverage === "search-extended" && addElapsedWarning()) {
      try {
        if (!beginRequest()) {
          throw new Error("People discovery search skipped because its request budget was exhausted");
        }
        const results = await searchProvider.search(
          `${company.name} team leadership`,
          budgets.maxSearchResultsPerCompany
        );
        const searchWithinTime = addElapsedWarning();
        const boundedResults = results.slice(0, budgets.maxSearchResultsPerCompany);
        if (results.length > boundedResults.length) {
          warnings.push({
            code: "budget-exhausted",
            sourceUrl: websiteUrl,
            message: `Search result budget truncated ${results.length} results to ${boundedResults.length}`
          });
        }
        const freshResults = boundedResults.filter((result) => {
          if (result.checkedAt === undefined) {
            warnings.push({
              code: "invalid-data",
              sourceUrl: result.url.slice(0, FIELD_LIMITS.url.characters),
              message: "Search result checkedAt is required"
            });
            return false;
          }
          if (!withinFieldLimit(result.url, FIELD_LIMITS.url)) {
            warnings.push({
              code: "invalid-data",
              sourceUrl: result.url.slice(0, FIELD_LIMITS.url.characters),
              message: `Search result URL exceeds ${FIELD_LIMITS.url.characters} characters or ${FIELD_LIMITS.url.bytes} UTF-8 bytes`
            });
            return false;
          }
          if (!withinFieldLimit(result.title, FIELD_LIMITS.title)) {
            warnings.push({
              code: "invalid-data",
              sourceUrl: result.url,
              message: `Search result title exceeds ${FIELD_LIMITS.title.characters} characters or ${FIELD_LIMITS.title.bytes} UTF-8 bytes`
            });
            return false;
          }
          try {
            const freshness = validateSourceTimestamp(result.checkedAt, now(), "Search result");
            if (freshness.stale) {
              warnings.push({
                code: "stale-source",
                sourceUrl: result.url,
                message: "Search result is older than the 30-day freshness policy"
              });
            }
            return true;
          } catch (error) {
            warnings.push(warning(result.url, error));
            return false;
          }
        });
        const searchUrls = new Set((searchWithinTime ? freshResults : []).map(
          (result) => normalizedHttpUrl(result.url)
        ).filter(
          (url): url is string => url !== undefined && !isLinkedInUrl(url)
        ));
        for (const url of Array.from(searchUrls).sort((left, right) => left.localeCompare(right, "en"))) {
          if (fetchedUrls.has(url)) {
            continue;
          }
          if (!beginRequest()) {
            break;
          }
          try {
            const page = await fetchPage(url);
            fetchedUrls.add(page.url);
            const parsedPage = parsePeople(page, companyId, 0.75, false, now());
            checkedTimes.push(page.checkedAt);
            discovered.push(...parsedPage.people);
            warnings.push(...parsedPage.warnings);
            if (!parsedPage.recognized) {
              warnings.push({
                code: "source-changed",
                sourceUrl: page.url,
                message: "Public people page has no recognized team or leadership structure"
              });
            }
            if (!addElapsedWarning()) {
              break;
            }
          } catch (error) {
            warnings.push(warning(url, error));
          }
        }
      } catch (error) {
        warnings.push(warning(websiteUrl, error));
      }
    }

    const uniquePeople = new Map<string, DiscoveredPerson>();
    for (const person of discovered) {
      const key = deduplicationKey(person);
      const existing = uniquePeople.get(key);
      if (existing === undefined || person.confidence > existing.confidence) {
        uniquePeople.set(key, person);
      } else if (existing.publicProfileUrl === undefined && person.publicProfileUrl !== undefined) {
        uniquePeople.set(key, { ...existing, publicProfileUrl: person.publicProfileUrl });
      }
    }

    const people: PersonWithEvidence[] = [];
    const allEvidence: Evidence[] = [];
    const sortedPeople = Array.from(uniquePeople.values()).sort((left, right) => {
      return left.name.localeCompare(right.name, "en") || left.role.localeCompare(right.role, "en");
    });
    const refreshedRows = dependencies.repositories.people.refreshDiscovery({
      companyId,
      people: sortedPeople.map((person) => ({
        name: person.name,
        role: person.role,
        checkedAt: person.checkedAt,
        ...(person.publicProfileUrl === undefined ? {} : { publicProfileUrl: person.publicProfileUrl }),
        evidence: [{
          sourceUrl: person.sourceUrl,
          title: person.sourceTitle,
          factType: "public_role",
          fact: person.fact,
          checkedAt: person.checkedAt,
          confidence: person.confidence
        }]
      }))
    });
    for (const [index, person] of sortedPeople.entries()) {
      const row = refreshedRows[index]!;
      const evidenceRow = row.evidence[0]!;
      const evidence = evidenceFor(person, evidenceRow.id);
      allEvidence.push(evidence);
      people.push({
        id: row.id,
        companyId: person.companyId,
        name: person.name,
        role: person.role,
        ...(person.publicProfileUrl === undefined ? {} : { publicProfileUrl: person.publicProfileUrl }),
        checkedAt: person.checkedAt,
        confidence: person.confidence,
        evidence: [evidence]
      });
    }

    const checkedAt = checkedTimes.sort().at(-1) ?? now().toISOString();
    return {
      people,
      evidence: allEvidence,
      checkedAt,
      coverage: searchProvider.coverage,
      warnings: warnings.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl, "en"))
    };
  };

  return { discoverPublicPeople };
}
