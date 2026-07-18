import { load } from "cheerio";
import { fetchPublicPage, type FetchedPage } from "./fetch-page.js";
import { validateSourceTimestamp } from "./source-validation.js";
import { assertFetchableUrlLocation } from "./url-policy.js";
import type { CompanyResult, CompanySearchQuery, Evidence, SourceWarning } from "./types.js";

const YC_ORIGINS = new Set(["https://www.ycombinator.com", "https://ycombinator.com"]);
const YC_DIRECTORY_URL = "https://www.ycombinator.com/companies";
const YC_DEFAULT_FACET_URL = `${YC_DIRECTORY_URL}/industry/marketing`;
const MAX_DETAIL_HYDRATIONS = 50;
const MAX_DETAIL_CONCURRENCY = 4;
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
  fetch(query?: CompanySearchQuery): Promise<YcSourcePage>;
  fetchCompanyDetail?(url: string): Promise<YcSourcePage>;
}

function facetSlug(value: string): string {
  const primary = value.split("/", 1)[0] ?? value;
  const slug = primary.toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug === "" ? "marketing" : slug;
}

function locationSlug(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en");
  if (normalized.includes("san francisco") || normalized.includes("bay area")) {
    return "san-francisco-bay-area";
  }
  return facetSlug(value);
}

function publicFacetUrl(query: CompanySearchQuery = {}): string {
  if (query.industry !== undefined && query.industry.trim() !== "") {
    return `${YC_DIRECTORY_URL}/industry/${facetSlug(query.industry)}`;
  }
  if (query.location !== undefined && query.location.trim() !== "") {
    return `${YC_DIRECTORY_URL}/location/${locationSlug(query.location)}${
      query.hiring === true ? "/hiring" : ""
    }`;
  }
  if (query.hiring === true) {
    return `${YC_DIRECTORY_URL}/location/san-francisco-bay-area/hiring`;
  }
  return YC_DEFAULT_FACET_URL;
}

export function describeYcCompanyCoverage(query: CompanySearchQuery = {}) {
  return {
    coverage: "authoritative-page-only" as const,
    complete: false as const,
    sourceUrl: publicFacetUrl(query),
    limitation: "Results are limited to the selected official server-rendered YC facet page. An empty result is not proof that no matching YC company exists."
  };
}

export function createPublicYcSource(
  fetchPage: (url: string) => Promise<FetchedPage> = fetchPublicPage
): YcSource {
  return {
    fetch: async (query = {}) => {
      const requestedUrl = publicFacetUrl(query);
      const page = await fetchPage(requestedUrl);
      const finalUrl = new URL(page.url);
      if (!YC_ORIGINS.has(finalUrl.origin)) {
        throw new SourceChangedError("The production YC source final origin is not approved");
      }
      if (!/^\/companies\/(?:industry|location)\/[a-z0-9-]+(?:\/hiring)?$/.test(finalUrl.pathname)) {
        throw new SourceChangedError("The production YC source final pathname is not an approved company list");
      }
      return { html: page.html, url: page.url, checkedAt: page.checkedAt };
    },
    fetchCompanyDetail: async (url) => {
      const requestedUrl = exactYcCompanyDetailUrl(url, "input");
      const page = await fetchPage(url);
      const finalUrl = exactYcCompanyDetailUrl(page.url, "final");
      if (finalUrl.pathname !== requestedUrl.pathname) {
        throw new SourceChangedError(
          "The production YC company detail final response did not remain bound to the same company pathname"
        );
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

function exactYcCompanyDetailUrl(value: string, position: "input" | "final"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceChangedError(
      `The production YC company detail ${position} URL is invalid`
    );
  }
  if (!YC_ORIGINS.has(url.origin)) {
    throw new SourceChangedError(
      `The production YC company detail ${position} origin is not approved`
    );
  }
  if (!/^\/companies\/[a-z0-9-]+$/.test(url.pathname)) {
    throw new SourceChangedError(
      `The production YC company detail ${position} pathname is not an approved company detail`
    );
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new SourceChangedError(
      `The production YC company detail ${position} URL is not an exact approved company detail`
    );
  }
  return url;
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

type WebsiteEnrichment = {
  websiteUrl: string;
  evidence: Evidence;
  staleWarning?: SourceWarning;
};

function websiteEnrichmentFromDetail(
  company: CompanyResult,
  page: YcSourcePage,
  now: Date
): WebsiteEnrichment | undefined {
  const freshness = validateSourceTimestamp(page.checkedAt, now, "YC company detail source");
  const $ = load(page.html);
  const href = $('a[aria-label="Company website"]').first().attr("href");
  if (href === undefined) {
    return undefined;
  }
  let website: URL;
  try {
    website = new URL(href, page.url);
    assertFetchableUrlLocation(website);
  } catch {
    return undefined;
  }
  const websiteUrl = website.href;
  const title = optionalText($("title").first().text()) ?? `${company.name} | Y Combinator`;
  const evidence: Evidence = {
    id: `yc-${company.ycId}-website`,
    url: websiteUrl,
    sourceUrl: page.url,
    title,
    fact: `Y Combinator lists this link as the company website for ${company.name}`,
    checkedAt: freshness.checkedAt,
    confidence: 1
  };
  const boundedFields: Array<readonly [string, string, {
    characters: number;
    bytes: number;
  }]> = [
    ["website evidence ID", evidence.id, FIELD_LIMITS.id],
    ["company website URL", evidence.url, FIELD_LIMITS.url],
    ["website evidence source URL", evidence.sourceUrl, FIELD_LIMITS.url],
    ["website evidence title", evidence.title, FIELD_LIMITS.title],
    ["website evidence fact", evidence.fact, FIELD_LIMITS.fact]
  ];
  if (boundedFields.some(([_label, value, limit]) => !withinFieldLimit(value, limit))) {
    return undefined;
  }
  return {
    websiteUrl,
    evidence,
    ...(freshness.stale ? {
      staleWarning: {
        code: "stale-source" as const,
        sourceUrl: page.url,
        message: "YC company detail source is older than the 30-day freshness policy"
      }
    } : {})
  };
}

async function hydrateCompanyWebsites(
  companies: CompanyResult[],
  fetchCompanyDetail: ((url: string) => Promise<YcSourcePage>) | undefined,
  now: Date
): Promise<CompanyResult[]> {
  if (fetchCompanyDetail === undefined) {
    return companies;
  }
  const hydrated = [...companies];
  const targetIndexes = companies.flatMap((company, index) => {
    const detailUrl = company.sources[0]?.sourceUrl;
    return company.websiteUrl === undefined && detailUrl !== undefined ? [index] : [];
  }).slice(0, MAX_DETAIL_HYDRATIONS);
  let nextTarget = 0;
  const hydrateNext = async (): Promise<void> => {
    while (nextTarget < targetIndexes.length) {
      const targetIndex = targetIndexes[nextTarget];
      nextTarget += 1;
      if (targetIndex === undefined) {
        return;
      }
      const company = companies[targetIndex];
      const detailUrl = company?.sources[0]?.sourceUrl;
      if (company === undefined || detailUrl === undefined) {
        continue;
      }
      try {
        const page = await fetchCompanyDetail(detailUrl);
        const enrichment = websiteEnrichmentFromDetail(company, page, now);
        if (enrichment !== undefined) {
          hydrated[targetIndex] = {
            ...company,
            websiteUrl: enrichment.websiteUrl,
            sources: [...company.sources, enrichment.evidence],
            warnings: [
              ...company.warnings,
              ...(enrichment.staleWarning === undefined ? [] : [enrichment.staleWarning])
            ]
          };
        }
      } catch {
        // A detail page is optional enrichment; preserve the selected list result on safe failure.
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_DETAIL_CONCURRENCY, targetIndexes.length) },
    hydrateNext
  ));
  return hydrated;
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
  const sourceTitle = optionalText($("title").first().text()) ?? "Y Combinator Companies";

  if (directory.length !== 1 || cards.length === 0) {
    const currentCards = $("ul > li").filter((_index, card) => {
      const element = $(card);
      return element.find(".text-2xl").length === 1
        && element.find("a[href*='/companies/']").length > 0;
    }).toArray();
    if (currentCards.length === 0) {
      throw new SourceChangedError();
    }
    const results: CompanyResult[] = [];
    const invalidWarnings: SourceWarning[] = [];
    for (const card of currentCards) {
      const element = $(card);
      const href = element.find("a[href*='/companies/']").first().attr("href");
      const name = normalizedText(element.find(".text-2xl").first().text());
      if (href === undefined || name === "") {
        throw new SourceChangedError("A YC company card no longer has the recognizable required fields");
      }
      const ycUrl = assertYcCompanyUrl(href, page.url);
      const ycId = new URL(ycUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
      const detailTexts = element.find(".text-gray-700").toArray()
        .map((item) => normalizedText($(item).text()))
        .filter((item) => item !== "");
      const batch = element.find("span").toArray()
        .map((item) => normalizedText($(item).text()))
        .find((item) => /^(?:[WSFP]\d{2,4}|(?:Winter|Summer|Fall|Spring)\s+\d{4})$/i.test(item));
      const status = detailTexts[0];
      const location = detailTexts
        .filter((item) => !/^\d+\s+employees?$/i.test(item) && item !== status)
        .at(-1);
      const rawDescription = optionalText(
        element.find(".line-clamp-3.text-gray-600").first().text()
      );
      const description = rawDescription !== undefined
        && withinFieldLimit(rawDescription, FIELD_LIMITS.description)
        ? rawDescription
        : undefined;
      const tags = element.find("div.mt-2").last().children("div").toArray()
        .map((item) => normalizedText($(item).text()))
        .filter((item) => item !== "");
      const industry = tags.length === 0 ? undefined : tags.join(" / ");
      const warnings: SourceWarning[] = [];
      if (rawDescription !== undefined && description === undefined) {
        warnings.push({
          code: "invalid-data",
          sourceUrl: page.url,
          message: "Omitted an oversized YC company description"
        });
      }
      if (freshness.stale) {
        warnings.push({
          code: "stale-source",
          sourceUrl: page.url,
          message: "YC source is older than the 30-day freshness policy"
        });
      }
      const raw: RawYcCompany = {
        ycId,
        name,
        ycUrl,
        sourceTitle,
        checkedAt,
        ...(batch === undefined ? {} : { batch }),
        ...(status === undefined ? {} : { status }),
        ...(location === undefined ? {} : { location }),
        ...(industry === undefined ? {} : { industry }),
        ...(description === undefined ? {} : { description }),
        ...(new URL(page.url).pathname.endsWith("/hiring") ? { hiring: true } : {}),
        ...(warnings.length === 0 ? {} : { warnings })
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
    if (invalidWarnings.length > 0) {
      throw new SourceChangedError(
        `YC company list contains ${invalidWarnings.length} invalid recognizable company cards`
      );
    }
    return results;
  }

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
  if (invalidWarnings.length > 0) {
    const label = invalidWarnings.length === 1 ? "card" : "cards";
    throw new SourceChangedError(
      `YC directory contains ${invalidWarnings.length} invalid recognizable company ${label}: ${
        invalidWarnings.map(({ message }) => message).join("; ")
      }`
    );
  }
  return results;
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
    const now = (options.now ?? (() => new Date()))();
    const companies = parseCompanies(await source.fetch(query), now);
    const selected = companies.filter((company) => matches(company, query)).sort((left, right) => {
      return left.name.localeCompare(right.name, "en") || left.ycId.localeCompare(right.ycId, "en");
    });
    return await hydrateCompanyWebsites(selected, source.fetchCompanyDetail?.bind(source), now);
  };
  return { searchYcCompanies, search: searchYcCompanies };
}

export async function searchYcCompanies(
  query: CompanySearchQuery,
  source: YcSource = createPublicYcSource()
): Promise<CompanyResult[]> {
  return await createYcProvider(source).searchYcCompanies(query);
}
