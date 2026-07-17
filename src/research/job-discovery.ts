import { load } from "cheerio";
import type { CareerDatabase } from "../db/client.js";
import { fetchPublicPage, type FetchedPage } from "./fetch-page.js";
import type {
  CareerPreferences,
  Opportunity,
  OpportunitySearchResult,
  SourceWarning
} from "./types.js";

const CAREERS_PAGE_PATTERN = /(?:^|[\s/_-])(careers?|jobs?|openings?|positions?)(?:$|[\s/_-])/i;
const CLOSED_STATUS_PATTERN = /\b(?:closed|filled|expired|inactive|no longer accepting)\b/i;

type JobRepositories = Pick<CareerDatabase, "companies">;

export type JobDiscoveryDependencies = {
  repositories: JobRepositories;
  fetchPage?: (url: string) => Promise<FetchedPage>;
  now?: () => Date;
};

type ParsedJob = Opportunity & {
  deduplicationKey: string;
};

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedMatchText(value: string): string {
  return normalizedText(value).toLocaleLowerCase("en");
}

function assertIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Official careers source checkedAt must be an ISO timestamp");
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

function parseJobs(
  page: FetchedPage,
  companyId: string,
  preferences: CareerPreferences
): ParsedJob[] {
  const checkedAt = assertIsoTimestamp(page.checkedAt);
  const $ = load(page.html);
  const jobs: ParsedJob[] = [];
  for (const card of $("[data-job-posting]").toArray()) {
    const title = normalizedText($(card).find("[data-job-title]").first().text());
    const location = normalizedText($(card).find("[data-job-location]").first().text());
    const status = normalizedText($(card).find("[data-job-status]").first().text());
    const href = $(card).find("a[data-job-url]").first().attr("href");
    if (title === "" || href === undefined || CLOSED_STATUS_PATTERN.test(status)) {
      continue;
    }
    if ($(card).is("[data-job-closed], [aria-disabled='true']")) {
      continue;
    }
    const sourceUrl = normalizedHttpUrl(href, page.url);
    if (
      sourceUrl === undefined
      || isLinkedInUrl(sourceUrl)
      || !matchesRole(title, preferences)
      || !matchesLocation(location === "" ? undefined : location, preferences)
    ) {
      continue;
    }
    const jobId = normalizedText($(card).attr("data-job-id") ?? "");
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
  return jobs;
}

function careersPageUrls(page: FetchedPage): string[] {
  const pageUrl = new URL(page.url);
  const $ = load(page.html);
  const urls = new Set<string>();
  for (const anchor of $("a[href]").toArray()) {
    if ($(anchor).is("[data-job-url]") || $(anchor).closest("[data-job-posting]").length > 0) {
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
      urls.add(url);
    }
  }
  return Array.from(urls).sort((left, right) => left.localeCompare(right, "en"));
}

function sourceWarning(sourceUrl: string, error: unknown): SourceWarning {
  return {
    sourceUrl,
    message: error instanceof Error ? error.message : "Official careers source request failed"
  };
}

function resultWithMetadata(
  opportunities: Opportunity[],
  warnings: SourceWarning[],
  checkedAt: string
): OpportunitySearchResult {
  const result = opportunities as OpportunitySearchResult;
  result.warnings = warnings;
  result.checkedAt = checkedAt;
  return result;
}

export function createJobDiscovery(dependencies: JobDiscoveryDependencies): {
  findPmmOpportunities(
    companyIds: string[],
    preferences: CareerPreferences
  ): Promise<OpportunitySearchResult>;
} {
  const fetchPage = dependencies.fetchPage ?? fetchPublicPage;
  const now = dependencies.now ?? (() => new Date());

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

      let homePage: FetchedPage;
      try {
        homePage = await fetchPage(websiteUrl);
        checkedTimes.push(assertIsoTimestamp(homePage.checkedAt));
        for (const job of parseJobs(homePage, companyId, preferences)) {
          jobs.set(`${companyId}\u0000${job.deduplicationKey}`, job);
        }
      } catch (error) {
        warnings.push(sourceWarning(websiteUrl, error));
        continue;
      }

      const fetchedUrls = new Set([homePage.url]);
      for (const url of careersPageUrls(homePage)) {
        if (fetchedUrls.has(url)) {
          continue;
        }
        try {
          const page = await fetchPage(url);
          fetchedUrls.add(page.url);
          checkedTimes.push(assertIsoTimestamp(page.checkedAt));
          for (const job of parseJobs(page, companyId, preferences)) {
            const key = `${companyId}\u0000${job.deduplicationKey}`;
            if (!jobs.has(key)) {
              jobs.set(key, job);
            }
          }
        } catch (error) {
          warnings.push(sourceWarning(url, error));
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

export async function findPmmOpportunities(
  companyIds: string[],
  preferences: CareerPreferences,
  dependencies: JobDiscoveryDependencies
): Promise<OpportunitySearchResult> {
  return await createJobDiscovery(dependencies).findPmmOpportunities(companyIds, preferences);
}
