import { load } from "cheerio";
import type { CareerDatabase } from "../db/client.js";
import type { FetchedPage } from "./fetch-page.js";
import { fetchPublicPage } from "./fetch-page.js";
import { DisabledSearchProvider, type SearchProvider } from "./search-provider.js";
import type {
  DiscoveryResult,
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
};

type DiscoveredPerson = {
  companyId: string;
  name: string;
  role: string;
  sourceUrl: string;
  sourceTitle: string;
  checkedAt: string;
  confidence: number;
  publicProfileUrl?: string;
};

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assertIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Public people source checkedAt must be an ISO timestamp");
  }
  return value;
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
  allowLinkedInProfile: boolean
): DiscoveredPerson[] {
  const checkedAt = assertIsoTimestamp(page.checkedAt);
  const $ = load(page.html);
  const parsed: DiscoveredPerson[] = [];
  for (const card of $("[data-team-member]").toArray()) {
    const name = normalizedText($(card).find("[data-person-name]").first().text());
    const role = normalizedText($(card).find("[data-person-role]").first().text());
    if (name === "" || role === "") {
      continue;
    }
    const publicProfileUrl = allowLinkedInProfile
      ? explicitLinkedInUrl($, card, page.url)
      : undefined;
    parsed.push({
      companyId,
      name,
      role,
      sourceUrl: page.url,
      sourceTitle: normalizedText(page.title) || "Official company page",
      checkedAt,
      confidence,
      ...(publicProfileUrl === undefined ? {} : { publicProfileUrl })
    });
  }
  return parsed;
}

function officialPageUrls(page: FetchedPage): string[] {
  const pageUrl = new URL(page.url);
  const $ = load(page.html);
  const urls = new Set<string>();
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
      urls.add(url);
    }
  }
  return Array.from(urls).sort((left, right) => left.localeCompare(right, "en"));
}

function deduplicationKey(person: Pick<DiscoveredPerson, "name" | "role">): string {
  return `${person.name.toLocaleLowerCase("en")}\u0000${person.role.toLocaleLowerCase("en")}`;
}

function warning(sourceUrl: string, error: unknown): SourceWarning {
  return {
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
    fact: `${person.name} — ${person.role}`,
    checkedAt: person.checkedAt,
    confidence: person.confidence
  };
}

export function createPeopleDiscovery(dependencies: PeopleDiscoveryDependencies): {
  discoverPublicPeople(companyId: string): Promise<DiscoveryResult>;
} {
  const fetchPage = dependencies.fetchPage ?? fetchPublicPage;
  const searchProvider = dependencies.searchProvider ?? new DisabledSearchProvider();
  const now = dependencies.now ?? (() => new Date());

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
    let homePage: FetchedPage | undefined;
    try {
      homePage = await fetchPage(websiteUrl);
      fetchedUrls.add(homePage.url);
      checkedTimes.push(assertIsoTimestamp(homePage.checkedAt));
      discovered.push(...parsePeople(homePage, companyId, 0.95, true));
    } catch (error) {
      warnings.push(warning(websiteUrl, error));
    }

    const officialUrls = homePage === undefined ? [] : officialPageUrls(homePage);
    for (const url of officialUrls) {
      if (fetchedUrls.has(url)) {
        continue;
      }
      try {
        const page = await fetchPage(url);
        fetchedUrls.add(page.url);
        checkedTimes.push(assertIsoTimestamp(page.checkedAt));
        discovered.push(...parsePeople(page, companyId, 0.95, true));
      } catch (error) {
        warnings.push(warning(url, error));
      }
    }

    if (searchProvider.coverage === "search-extended") {
      try {
        const results = await searchProvider.search(`${company.name} team leadership`, 10);
        const searchUrls = new Set(results.map((result) => normalizedHttpUrl(result.url)).filter(
          (url): url is string => url !== undefined && !isLinkedInUrl(url)
        ));
        for (const url of Array.from(searchUrls).sort((left, right) => left.localeCompare(right, "en"))) {
          if (fetchedUrls.has(url)) {
            continue;
          }
          try {
            const page = await fetchPage(url);
            fetchedUrls.add(page.url);
            checkedTimes.push(assertIsoTimestamp(page.checkedAt));
            discovered.push(...parsePeople(page, companyId, 0.75, false));
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
    for (const person of Array.from(uniquePeople.values()).sort((left, right) => {
      return left.name.localeCompare(right.name, "en") || left.role.localeCompare(right.role, "en");
    })) {
      const row = dependencies.repositories.people.upsert({
        companyId: person.companyId,
        name: person.name,
        role: person.role,
        checkedAt: person.checkedAt,
        ...(person.publicProfileUrl === undefined ? {} : { publicProfileUrl: person.publicProfileUrl })
      });
      const evidenceRow = dependencies.repositories.evidence.add({
        personId: row.id,
        sourceUrl: person.sourceUrl,
        title: person.sourceTitle,
        factType: "public_role",
        fact: `${person.name} — ${person.role}`,
        checkedAt: person.checkedAt,
        confidence: person.confidence
      });
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

export async function discoverPublicPeople(
  companyId: string,
  dependencies: PeopleDiscoveryDependencies
): Promise<DiscoveryResult> {
  return await createPeopleDiscovery(dependencies).discoverPublicPeople(companyId);
}
