import { load } from "cheerio";
import { fetchPublicPage, type FetchedPage } from "./fetch-page.js";
import { validateSourceTimestamp } from "./source-validation.js";
import type { CompanyResult, CompanySearchQuery, Evidence, SourceWarning } from "./types.js";

const YC_ORIGINS = new Set(["https://www.ycombinator.com", "https://ycombinator.com"]);
const YC_DIRECTORY_URL = "https://www.ycombinator.com/companies";
const FIELD_LIMITS = {
  id: { characters: 160, bytes: 320 },
  name: { characters: 160, bytes: 320 },
  shortText: { characters: 240, bytes: 480 },
  description: { characters: 500, bytes: 1_000 },
  fact: { characters: 320, bytes: 640 },
  title: { characters: 300, bytes: 600 },
  url: { characters: 2_048, bytes: 4_096 }
} as const;

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
      const finalUrl = new URL(page.url);
      if (!YC_ORIGINS.has(finalUrl.origin)) {
        throw new SourceChangedError("The production YC source final origin is not approved");
      }
      if (finalUrl.pathname !== "/companies") {
        throw new SourceChangedError("The production YC source final pathname is not the approved directory");
      }
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
  warnings?: SourceWarning[];
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

function withinFieldLimit(value: string, limit: { characters: number; bytes: number }): boolean {
  return value.length <= limit.characters && Buffer.byteLength(value, "utf8") <= limit.bytes;
}

function invalidCompanyWarning(sourceUrl: string, field: string, limit: {
  characters: number;
  bytes: number;
}): SourceWarning {
  return {
    code: "invalid-data",
    sourceUrl: sourceUrl.slice(0, FIELD_LIMITS.url.characters),
    message: `Skipped YC company record because ${field} exceeds ${limit.characters} characters or ${limit.bytes} UTF-8 bytes`
  };
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

function companyFact(raw: RawYcCompany): string {
  return [
    `${raw.name} is listed by Y Combinator`,
    raw.batch === undefined ? undefined : `in batch ${raw.batch}`,
    raw.status === undefined ? undefined : `with status ${raw.status}`
  ].filter((part): part is string => part !== undefined).join(" ");
}

function companyEvidence(raw: RawYcCompany): Evidence {
  return {
    id: `yc-${raw.ycId}`,
    url: raw.ycUrl,
    sourceUrl: raw.ycUrl,
    title: raw.sourceTitle,
    fact: companyFact(raw),
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
    sources: [companyEvidence(raw)],
    warnings: raw.warnings ?? []
  };
}

function parseCompanies(page: YcSourcePage, now: Date): CompanyResult[] {
  const freshness = validateSourceTimestamp(page.checkedAt, now, "YC source");
  const checkedAt = freshness.checkedAt;
  const $ = load(page.html);
  const directory = $("[data-yc-company-directory]").first();
  const cards = directory.find("[data-yc-company-id]").toArray();
  if (directory.length !== 1 || cards.length === 0) {
    throw new SourceChangedError();
  }
  const sourceTitle = optionalText($("title").first().text()) ?? "Y Combinator Companies";

  const results: CompanyResult[] = [];
  const invalidWarnings: SourceWarning[] = [];
  for (const card of cards) {
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
    const ycUrl = assertYcCompanyUrl(href, page.url);
    const websiteUrl = websiteHref === undefined
      ? undefined
      : normalizedUrl(websiteHref, page.url);
    const raw: RawYcCompany = {
      ycId,
      name,
      ycUrl,
      sourceTitle,
      checkedAt,
      ...(freshness.stale ? {
        warnings: [{
          code: "stale-source" as const,
          sourceUrl: page.url,
          message: "YC source is older than the 30-day freshness policy"
        }]
      } : {}),
      ...(batch === undefined ? {} : { batch }),
      ...(status === undefined ? {} : { status }),
      ...(location === undefined ? {} : { location }),
      ...(industry === undefined ? {} : { industry }),
      ...(description === undefined ? {} : { description }),
      ...(hiring === undefined ? {} : { hiring }),
      ...(websiteUrl === undefined ? {} : { websiteUrl })
    };
    const boundedFields: Array<readonly [string, string | undefined, {
      characters: number;
      bytes: number;
    }]> = [
      ["company ID", ycId, FIELD_LIMITS.id],
      ["company name", name, FIELD_LIMITS.name],
      ["company batch", batch, FIELD_LIMITS.shortText],
      ["company status", status, FIELD_LIMITS.shortText],
      ["company location", location, FIELD_LIMITS.shortText],
      ["company industry", industry, FIELD_LIMITS.shortText],
      ["company description", description, FIELD_LIMITS.description],
      ["YC source title", sourceTitle, FIELD_LIMITS.title],
      ["YC company URL", ycUrl, FIELD_LIMITS.url],
      ["company website URL", websiteUrl, FIELD_LIMITS.url],
      ["evidence fact", companyFact(raw), FIELD_LIMITS.fact]
    ];
    const invalidField = boundedFields.find(([_label, value, limit]) => {
      return value !== undefined && !withinFieldLimit(value, limit);
    });
    if (invalidField !== undefined) {
      invalidWarnings.push(invalidCompanyWarning(page.url, invalidField[0], invalidField[2]));
      continue;
    }
    results.push(normalizeCompany(raw));
  }
  return results.map((company) => ({
    ...company,
    warnings: [...company.warnings, ...invalidWarnings]
  }));
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

export function createYcProvider(source: YcSource, options: { now?: () => Date } = {}): {
  searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]>;
  search(query: CompanySearchQuery): Promise<CompanyResult[]>;
} {
  const searchYcCompanies = async (query: CompanySearchQuery): Promise<CompanyResult[]> => {
    const companies = parseCompanies(await source.fetch(), (options.now ?? (() => new Date()))());
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
