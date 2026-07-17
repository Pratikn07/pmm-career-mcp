import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { load } from "cheerio";
import type { CareerDatabase } from "../db/client.js";
import {
  DiscoveryDeadlineError,
  withDiscoveryDeadline,
  type DiscoveryAdapterOptions
} from "./discovery-deadline.js";
import { fetchPublicPage, type FetchedPage } from "./fetch-page.js";
import { SourceTimestampError, validateSourceTimestamp } from "./source-validation.js";
import { assertFetchableUrl } from "./url-policy.js";
import type {
  CareerPreferences,
  DiscoveryBudgets,
  Opportunity,
  OpportunitySearchResult,
  SourceWarning
} from "./types.js";

const CAREERS_PAGE_PATTERN = /(?:^|[\s/_-])(careers?|jobs?|openings?|positions?)(?:$|[\s/_-])/i;
const CLOSED_STATUS_PATTERN = /\b(?:closed|filled|expired|inactive|no longer accepting)\b/i;
const JOB_CARD_SELECTOR = [
  "[data-job-posting]",
  "article.job-card",
  "article.job-listing",
  "article.job-posting",
  "article.opening-card",
  "li.job-card",
  "li.job-listing",
  "li.job-posting",
  "li.opening-card"
].join(", ");
const STATIC_POLICY_ADDRESS = "2606:4700:4700::1111";

type JobRepositories = Pick<CareerDatabase, "companies">;

export type JobDiscoveryDependencies = {
  repositories: JobRepositories;
  fetchPage?: (url: string, options: DiscoveryAdapterOptions) => Promise<FetchedPage>;
  resolveAddresses?: (hostname: string, options: DiscoveryAdapterOptions) => Promise<string[]>;
  now?: () => Date;
  elapsedNow?: () => number;
  budgets?: Partial<Pick<
    DiscoveryBudgets,
    "maxOfficialPagesPerCompany" | "maxTotalRequestsPerCompany" | "maxElapsedMsPerCompany"
  >>;
};

export interface JobDiscoveryService {
  findPmmOpportunities(
    companyIds: string[],
    preferences: CareerPreferences
  ): Promise<OpportunitySearchResult>;
}

const DEFAULT_DISCOVERY_BUDGETS = {
  maxOfficialPagesPerCompany: 5,
  maxTotalRequestsPerCompany: 8,
  maxElapsedMsPerCompany: 20_000
};

type ParsedJob = Opportunity & {
  deduplicationKey: string;
};

type ParsedJobsPage = {
  jobs: ParsedJob[];
  recognized: boolean;
  warnings: SourceWarning[];
};

const FIELD_LIMITS = {
  title: { characters: 240, bytes: 480 },
  location: { characters: 240, bytes: 480 },
  jobId: { characters: 160, bytes: 320 },
  url: { characters: 2_048, bytes: 4_096 }
} as const;

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedMatchText(value: string): string {
  return normalizedText(value).toLocaleLowerCase("en");
}

function withinFieldLimit(value: string, limit: { characters: number; bytes: number }): boolean {
  return value.length <= limit.characters && Buffer.byteLength(value, "utf8") <= limit.bytes;
}

function invalidJobWarning(sourceUrl: string, field: keyof typeof FIELD_LIMITS): SourceWarning {
  const limit = FIELD_LIMITS[field];
  const label = field === "jobId" ? "job ID" : field === "url" ? "job URL" : `job ${field}`;
  return {
    code: "invalid-data",
    sourceUrl,
    message: `Skipped official job record because ${label} exceeds ${limit.characters} characters or ${limit.bytes} UTF-8 bytes`
  };
}

function invalidCitationWarning(sourceUrl: string, message: string): SourceWarning {
  return { code: "invalid-data", sourceUrl, message };
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
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

function includesAny(value: string | null, filters: string[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  if (value === null) {
    return false;
  }
  const normalizedValue = normalizedMatchText(value);
  return filters.some((filter) => {
    const normalizedFilter = normalizedMatchText(filter);
    return normalizedFilter !== "" && normalizedValue.includes(normalizedFilter);
  });
}

function matchesIndustry(industry: string | null, preferences: CareerPreferences): boolean {
  return includesAny(industry, preferences.industries);
}

function matchesRole(title: string, preferences: CareerPreferences): boolean {
  if (preferences.roleKeywords.length === 0) {
    return false;
  }
  const normalizedTitle = normalizedMatchText(title);
  return preferences.roleKeywords.some((keyword) => {
    const normalizedKeyword = normalizedMatchText(keyword);
    return normalizedKeyword !== "" && normalizedTitle.includes(normalizedKeyword);
  });
}

function matchesLocation(location: string | undefined, preferences: CareerPreferences): boolean {
  return includesAny(location ?? null, preferences.preferredLocations);
}

async function parseJobs(
  page: FetchedPage,
  companyId: string,
  preferences: CareerPreferences,
  now: Date,
  resolveAddresses: (hostname: string) => Promise<string[]>
): Promise<ParsedJobsPage> {
  const freshness = validateSourceTimestamp(page.checkedAt, now, "Official careers source");
  const checkedAt = freshness.checkedAt;
  const $ = load(page.html);
  const jobs: ParsedJob[] = [];
  const warnings: SourceWarning[] = [];
  if (freshness.stale) {
    warnings.push({
      code: "stale-source",
      sourceUrl: page.url,
      message: "Official careers source is older than the 30-day freshness policy"
    });
  }
  const cards = $(JOB_CARD_SELECTOR).toArray();
  for (const card of cards) {
    const title = normalizedText($(card).find(
      "[data-job-title], .job-title, .position-title, .title, h2, h3, h4"
    ).first().text());
    const location = normalizedText($(card).find(
      "[data-job-location], .job-location, .location"
    ).first().text());
    const status = normalizedText($(card).find(
      "[data-job-status], .job-status, .status"
    ).first().text());
    const href = $(card).find("a[data-job-url], a[href]").first().attr("href");
    if (title === "" || href === undefined || CLOSED_STATUS_PATTERN.test(status)) {
      continue;
    }
    if ($(card).is("[data-job-closed], [aria-disabled='true']")) {
      continue;
    }
    if (!withinFieldLimit(title, FIELD_LIMITS.title)) {
      warnings.push(invalidJobWarning(page.url, "title"));
      continue;
    }
    if (location !== "" && !withinFieldLimit(location, FIELD_LIMITS.location)) {
      warnings.push(invalidJobWarning(page.url, "location"));
      continue;
    }
    const sourceUrl = normalizedHttpUrl(href, page.url);
    if (sourceUrl !== undefined && !withinFieldLimit(sourceUrl, FIELD_LIMITS.url)) {
      warnings.push(invalidJobWarning(page.url, "url"));
      continue;
    }
    if (
      sourceUrl === undefined
      || !matchesRole(title, preferences)
      || !matchesLocation(location === "" ? undefined : location, preferences)
    ) {
      continue;
    }
    const citationUrl = new URL(sourceUrl);
    try {
      assertFetchableUrl(citationUrl, [STATIC_POLICY_ADDRESS]);
    } catch {
      warnings.push(invalidCitationWarning(
        page.url,
        "Skipped official job record because its citation URL is not a public fetchable location"
      ));
      continue;
    }
    const pageOrigin = new URL(page.url).origin;
    const citationHostname = citationUrl.hostname.replace(/^\[|\]$/g, "");
    if (citationUrl.origin !== pageOrigin && isIP(citationHostname) === 0) {
      try {
        assertFetchableUrl(citationUrl, await resolveAddresses(citationHostname));
      } catch (error) {
        if (error instanceof DiscoveryDeadlineError) {
          throw error;
        }
        warnings.push(invalidCitationWarning(
          page.url,
          "Skipped official job record because its ATS hostname does not resolve only to public addresses"
        ));
        continue;
      }
    }
    const jobId = normalizedText($(card).attr("data-job-id") ?? "");
    if (jobId !== "" && !withinFieldLimit(jobId, FIELD_LIMITS.jobId)) {
      warnings.push(invalidJobWarning(page.url, "jobId"));
      continue;
    }
    const deduplicationKey = jobId === ""
      ? `${normalizedMatchText(title)}\u0000${sourceUrl}`
      : `job-id:${normalizedMatchText(jobId)}`;
    jobs.push({
      id: `${companyId}:${jobId || sourceUrl}`,
      companyId,
      title,
      ...(location === "" ? {} : { location }),
      sourceUrl,
      checkedAt,
      active: true,
      deduplicationKey
    });
  }
  return { jobs, recognized: cards.length > 0, warnings };
}

function careersPageUrls(page: FetchedPage): {
  urls: string[];
  warnings: SourceWarning[];
} {
  const pageUrl = new URL(page.url);
  const $ = load(page.html);
  const urls = new Set<string>();
  const warnings: SourceWarning[] = [];
  for (const anchor of $("a[href]").toArray()) {
    if ($(anchor).is("[data-job-url]") || $(anchor).closest(JOB_CARD_SELECTOR).length > 0) {
      continue;
    }
    const href = $(anchor).attr("href");
    const url = href === undefined ? undefined : normalizedHttpUrl(href, page.url);
    if (url === undefined || isLinkedInUrl(url)) {
      continue;
    }
    const parsed = new URL(url);
    if (parsed.origin !== pageUrl.origin) {
      continue;
    }
    const label = `${parsed.pathname} ${normalizedText($(anchor).text())}`;
    if (CAREERS_PAGE_PATTERN.test(label)) {
      if (!withinFieldLimit(url, FIELD_LIMITS.url)) {
        warnings.push({
          code: "invalid-data",
          sourceUrl: page.url,
          message: "Official careers candidate URL exceeds 2048 characters or 4096 UTF-8 bytes"
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

function sourceWarning(sourceUrl: string, error: unknown): SourceWarning {
  return {
    ...(error instanceof SourceTimestampError ? { code: error.code } : {}),
    sourceUrl,
    message: error instanceof Error ? error.message : "Official careers source request failed"
  };
}

function resultWithMetadata(
  opportunities: Opportunity[],
  warnings: SourceWarning[],
  checkedAt: string
): OpportunitySearchResult {
  return { opportunities, warnings, checkedAt };
}

export function createJobDiscovery(dependencies: JobDiscoveryDependencies): JobDiscoveryService {
  const fetchPage = dependencies.fetchPage ?? (async (
    url: string,
    options: DiscoveryAdapterOptions
  ) => await fetchPublicPage(url, { signal: options.signal, timeoutMs: options.timeoutMs }));
  const resolveAddresses = dependencies.resolveAddresses ?? defaultResolveAddresses;
  const now = dependencies.now ?? (() => new Date());
  const elapsedNow = dependencies.elapsedNow ?? (() => performance.now());
  const budgets = { ...DEFAULT_DISCOVERY_BUDGETS, ...dependencies.budgets };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  const findPmmOpportunities = async (
    companyIds: string[],
    preferences: CareerPreferences
  ): Promise<OpportunitySearchResult> => {
    const warnings: SourceWarning[] = [];
    const jobs = new Map<string, ParsedJob>();
    const checkedTimes: string[] = [];

    for (const companyId of Array.from(new Set(companyIds)).sort()) {
      const company = dependencies.repositories.companies.get(companyId);
      if (company === undefined) {
        warnings.push({ sourceUrl: `company:${companyId}`, message: "Company was not found" });
        continue;
      }
      if (!matchesIndustry(company.industry, preferences)) {
        continue;
      }
      if (company.websiteUrl === null) {
        warnings.push({
          sourceUrl: `company:${companyId}`,
          message: "Company has no stored official website"
        });
        continue;
      }
      const websiteUrl = normalizedHttpUrl(company.websiteUrl);
      if (websiteUrl === undefined) {
        warnings.push({
          sourceUrl: company.websiteUrl,
          message: "Company has an invalid stored official website"
        });
        continue;
      }

      const startedAt = elapsedNow();
      let totalRequests = 0;
      let elapsedBudgetReported = false;
      let requestBudgetReported = false;
      const reportElapsedWarning = (): void => {
        if (!elapsedBudgetReported) {
          warnings.push({
            code: "budget-exhausted",
            sourceUrl: websiteUrl,
            message: `Careers discovery elapsed-time budget of ${budgets.maxElapsedMsPerCompany}ms was exhausted`
          });
          elapsedBudgetReported = true;
        }
      };
      const remainingMs = (): number => {
        return budgets.maxElapsedMsPerCompany - (elapsedNow() - startedAt);
      };
      const addElapsedWarning = (): boolean => {
        if (remainingMs() > 0) {
          return true;
        }
        reportElapsedWarning();
        return false;
      };
      const runWithinDeadline = async <T>(
        operation: (options: DiscoveryAdapterOptions) => Promise<T>
      ): Promise<T> => {
        try {
          return await withDiscoveryDeadline(remainingMs(), operation);
        } catch (error) {
          if (error instanceof DiscoveryDeadlineError) {
            reportElapsedWarning();
          }
          throw error;
        }
      };
      const resolveCitationAddresses = async (hostname: string): Promise<string[]> => {
        return await runWithinDeadline(async (options) => {
          return await resolveAddresses(hostname, options);
        });
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
              message: `Careers discovery total request budget of ${budgets.maxTotalRequestsPerCompany} was exhausted`
            });
            requestBudgetReported = true;
          }
          return false;
        }
        totalRequests += 1;
        return true;
      };

      let homePage: FetchedPage;
      try {
        if (!beginRequest()) {
          continue;
        }
        homePage = await runWithinDeadline(async (options) => await fetchPage(websiteUrl, options));
        const parsedHome = await parseJobs(
          homePage,
          companyId,
          preferences,
          now(),
          resolveCitationAddresses
        );
        checkedTimes.push(homePage.checkedAt);
        warnings.push(...parsedHome.warnings);
        for (const job of parsedHome.jobs) {
          jobs.set(`${companyId}\u0000${job.deduplicationKey}`, job);
        }
        if (CAREERS_PAGE_PATTERN.test(new URL(homePage.url).pathname) && !parsedHome.recognized) {
          warnings.push({
            code: "source-changed",
            sourceUrl: homePage.url,
            message: "Official careers page has no recognized job-listing structure"
          });
        }
        if (!addElapsedWarning()) {
          continue;
        }
      } catch (error) {
        if (!(error instanceof DiscoveryDeadlineError)) {
          warnings.push(sourceWarning(websiteUrl, error));
        }
        continue;
      }

      const fetchedUrls = new Set([homePage.url]);
      const careersCandidates = careersPageUrls(homePage);
      warnings.push(...careersCandidates.warnings);
      const allCareersUrls = careersCandidates.urls;
      const careersUrls = allCareersUrls.slice(0, budgets.maxOfficialPagesPerCompany);
      if (allCareersUrls.length > careersUrls.length) {
        warnings.push({
          code: "budget-exhausted",
          sourceUrl: websiteUrl,
          message: `Official careers page budget truncated ${allCareersUrls.length} candidates to ${careersUrls.length}`
        });
      }
      for (const url of careersUrls) {
        if (fetchedUrls.has(url)) {
          continue;
        }
        if (!beginRequest()) {
          break;
        }
        try {
          const page = await runWithinDeadline(async (options) => await fetchPage(url, options));
          fetchedUrls.add(page.url);
          const parsedPage = await parseJobs(
            page,
            companyId,
            preferences,
            now(),
            resolveCitationAddresses
          );
          checkedTimes.push(page.checkedAt);
          warnings.push(...parsedPage.warnings);
          for (const job of parsedPage.jobs) {
            const key = `${companyId}\u0000${job.deduplicationKey}`;
            if (!jobs.has(key)) {
              jobs.set(key, job);
            }
          }
          if (!parsedPage.recognized) {
            warnings.push({
              code: "source-changed",
              sourceUrl: page.url,
              message: "Official careers page has no recognized job-listing structure"
            });
          }
          if (!addElapsedWarning()) {
            break;
          }
        } catch (error) {
          if (!(error instanceof DiscoveryDeadlineError)) {
            warnings.push(sourceWarning(url, error));
          }
        }
      }
    }

    const opportunities = Array.from(jobs.values()).map(({ deduplicationKey: _key, ...job }) => job)
      .sort((left, right) => {
        return left.title.localeCompare(right.title, "en")
          || left.companyId.localeCompare(right.companyId, "en")
          || left.sourceUrl.localeCompare(right.sourceUrl, "en");
      });
    return resultWithMetadata(
      opportunities,
      warnings.sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl, "en")),
      checkedTimes.sort().at(-1) ?? now().toISOString()
    );
  };

  return { findPmmOpportunities };
}
