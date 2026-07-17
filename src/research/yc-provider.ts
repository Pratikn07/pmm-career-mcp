import { load } from "cheerio";
import { fetchPublicPage, type FetchedPage } from "./fetch-page.js";
import type { CompanyResult, CompanySearchQuery, Evidence } from "./types.js";

const YC_ORIGINS = new Set(["https://www.ycombinator.com", "https://ycombinator.com"]);
const YC_DIRECTORY_URL = "https://www.ycombinator.com/companies";

export type YcSourcePage = {
  html: string;
  url: string;
  checkedAt: string;
};

export interface YcSource {
  fetch(): Promise<YcSourcePage>;
}

export function createPublicYcSource(
  fetchPage: (url: string) => Promise<FetchedPage> = fetchPublicPage
): YcSource {
  return {
    fetch: async () => {
      const page = await fetchPage(YC_DIRECTORY_URL);
      return { html: page.html, url: page.url, checkedAt: page.checkedAt };
    }
  };
}

export type RawYcCompany = {
  ycId: string;
  name: string;
  ycUrl: string;
  sourceTitle: string;
  checkedAt: string;
  batch?: string;
  status?: string;
  location?: string;
  industry?: string;
  description?: string;
  hiring?: boolean;
  websiteUrl?: string;
};

export class SourceChangedError extends Error {
  constructor(message = "The recognizable YC company directory layout has changed") {
    super(message);
    this.name = "SourceChangedError";
  }
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assertIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("YC source checkedAt must be an ISO timestamp in YYYY-MM-DDTHH:mm:ss.sssZ format");
  }
  return value;
}

function normalizedUrl(value: string, baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new SourceChangedError("The YC directory contains an invalid public URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceChangedError("The YC directory contains an unsupported public URL");
  }
  return url.href;
}

function assertYcCompanyUrl(value: string, baseUrl: string): string {
  const normalized = normalizedUrl(value, baseUrl);
  const url = new URL(normalized);
  if (!YC_ORIGINS.has(url.origin) || !url.pathname.startsWith("/companies/")) {
    throw new SourceChangedError("The YC directory company link is no longer a recognizable YC URL");
  }
  return normalized;
}

function optionalText(value: string): string | undefined {
  const normalized = normalizedText(value);
  return normalized === "" ? undefined : normalized;
}

function parseHiring(value: string): boolean | undefined {
  const normalized = normalizedText(value).toLowerCase();
  if (normalized === "yes" || normalized === "hiring") {
    return true;
  }
  if (normalized === "no" || normalized === "not hiring") {
    return false;
  }
  return undefined;
}

function companyEvidence(raw: RawYcCompany): Evidence {
  const fact = [
    `${raw.name} is listed by Y Combinator`,
    raw.batch === undefined ? undefined : `in batch ${raw.batch}`,
    raw.status === undefined ? undefined : `with status ${raw.status}`
  ].filter((part): part is string => part !== undefined).join(" ");
  return {
    id: `yc-${raw.ycId}`,
    url: raw.ycUrl,
    sourceUrl: raw.ycUrl,
    title: raw.sourceTitle,
    fact,
    checkedAt: raw.checkedAt,
    confidence: 1
  };
}

export function normalizeCompany(raw: RawYcCompany): CompanyResult {
  return {
    id: raw.ycId,
    ycId: raw.ycId,
    name: raw.name,
    ...(raw.batch === undefined ? {} : { batch: raw.batch }),
    ...(raw.status === undefined ? {} : { status: raw.status }),
    ...(raw.location === undefined ? {} : { location: raw.location }),
    ...(raw.industry === undefined ? {} : { industry: raw.industry }),
    ...(raw.description === undefined ? {} : { description: raw.description }),
    ...(raw.hiring === undefined ? {} : { hiring: raw.hiring }),
    ...(raw.websiteUrl === undefined ? {} : { websiteUrl: raw.websiteUrl }),
    checkedAt: raw.checkedAt,
    sources: [companyEvidence(raw)]
  };
}

function parseCompanies(page: YcSourcePage): CompanyResult[] {
  const checkedAt = assertIsoTimestamp(page.checkedAt);
  const $ = load(page.html);
  const directory = $("[data-yc-company-directory]").first();
  const cards = directory.find("[data-yc-company-id]").toArray();
  if (directory.length !== 1 || cards.length === 0) {
    throw new SourceChangedError();
  }
  const sourceTitle = optionalText($("title").first().text()) ?? "Y Combinator Companies";

  return cards.map((card) => {
    const element = $(card);
    const ycId = normalizedText(element.attr("data-yc-company-id") ?? "");
    const nameLink = element.find("a.company-name").first();
    const name = normalizedText(nameLink.text());
    const href = nameLink.attr("href");
    if (ycId === "" || name === "" || href === undefined) {
      throw new SourceChangedError("A YC company card no longer has the recognizable required fields");
    }
    const websiteHref = element.find("a[data-company-website]").first().attr("href");
    const batch = optionalText(element.find("[data-company-batch]").first().text());
    const status = optionalText(element.find("[data-company-status]").first().text());
    const location = optionalText(element.find("[data-company-location]").first().text());
    const industry = optionalText(element.find("[data-company-industry]").first().text());
    const description = optionalText(element.find(".company-description").first().text());
    const hiring = parseHiring(element.find("[data-company-hiring]").first().text());
    const raw: RawYcCompany = {
      ycId,
      name,
      ycUrl: assertYcCompanyUrl(href, page.url),
      sourceTitle,
      checkedAt,
      ...(batch === undefined ? {} : { batch }),
      ...(status === undefined ? {} : { status }),
      ...(location === undefined ? {} : { location }),
      ...(industry === undefined ? {} : { industry }),
      ...(description === undefined ? {} : { description }),
      ...(hiring === undefined ? {} : { hiring }),
      ...(websiteHref === undefined ? {} : { websiteUrl: normalizedUrl(websiteHref, page.url) })
    };
    return normalizeCompany(raw);
  });
}

function includesNormalized(value: string | undefined, query: string): boolean {
  return value?.toLocaleLowerCase("en").includes(query) ?? false;
}

function matches(company: CompanyResult, query: CompanySearchQuery): boolean {
  const matchText = (value: string | undefined, requested: string | undefined) => {
    const normalizedQuery = requested?.trim().toLocaleLowerCase("en");
    return normalizedQuery === undefined || normalizedQuery === ""
      || includesNormalized(value, normalizedQuery);
  };
  if (!matchText(company.batch, query.batch)) return false;
  if (!matchText(company.industry, query.industry)) return false;
  if (!matchText(company.status, query.status)) return false;
  if (!matchText(company.location, query.location)) return false;
  if (query.hiring !== undefined && company.hiring !== query.hiring) return false;
  const keyword = query.keyword?.trim().toLocaleLowerCase("en");
  if (keyword === undefined || keyword === "") return true;
  return [
    company.name,
    company.description,
    company.industry,
    company.location,
    company.batch,
    company.status
  ].some((value) => includesNormalized(value, keyword));
}

export function createYcProvider(source: YcSource): {
  searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]>;
  search(query: CompanySearchQuery): Promise<CompanyResult[]>;
} {
  const searchYcCompanies = async (query: CompanySearchQuery): Promise<CompanyResult[]> => {
    const companies = parseCompanies(await source.fetch());
    return companies.filter((company) => matches(company, query)).sort((left, right) => {
      return left.name.localeCompare(right.name, "en") || left.ycId.localeCompare(right.ycId, "en");
    });
  };
  return { searchYcCompanies, search: searchYcCompanies };
}

export async function searchYcCompanies(
  query: CompanySearchQuery,
  source: YcSource = createPublicYcSource()
): Promise<CompanyResult[]> {
  return await createYcProvider(source).searchYcCompanies(query);
}
