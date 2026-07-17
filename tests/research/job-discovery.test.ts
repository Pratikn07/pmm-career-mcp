import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type TestCareerDatabase } from "../../src/db/client.js";
import type { FetchedPage } from "../../src/research/fetch-page.js";
import { createJobDiscovery, findPmmOpportunities } from "../../src/research/job-discovery.js";

const fixturePath = fileURLToPath(new URL("../fixtures/company-careers.html", import.meta.url));
const CHECKED_AT = "2026-07-16T14:00:00.000Z";
const HOME_URL = "https://acme.example/";
const CAREERS_URL = "https://acme.example/careers";

function fetchedPage(url: string, html: string, title: string): FetchedPage {
  return {
    url,
    title,
    text: "Synthetic visible official careers page text",
    html,
    checkedAt: CHECKED_AT,
    contentType: "text/html",
    untrusted: true
  };
}

describe("PMM opportunity discovery", () => {
  let database: TestCareerDatabase;

  beforeEach(() => {
    database = createDatabase(":memory:");
  });

  afterEach(() => database.close());

  it("finds configured active marketing roles from official careers HTML", async () => {
    const company = database.companies.upsert({
      ycId: "acme-ai-jobs",
      name: "Acme AI",
      websiteUrl: HOME_URL,
      industry: "B2B / AI"
    });
    const careersHtml = await readFile(fixturePath, "utf8");
    const requestedUrls: string[] = [];
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      requestedUrls.push(url);
      if (url === HOME_URL) {
        return fetchedPage(url, `
          <nav>
            <a href="/careers">Careers</a>
            <a href="https://outside.example/jobs">Partner jobs</a>
            <a href="https://www.linkedin.com/company/acme-ai/jobs">Jobs on LinkedIn</a>
          </nav>
        `, "Acme AI");
      }
      if (url === CAREERS_URL) {
        return fetchedPage(url, careersHtml, "Careers | Acme AI");
      }
      throw new Error(`Unexpected page request: ${url}`);
    };
    const preferences = {
      roleKeywords: ["product marketing", "growth marketing"],
      preferredLocations: ["San Francisco", "Remote"],
      industries: ["AI"]
    };

    const opportunities = await findPmmOpportunities([company.id], preferences, {
      repositories: database,
      fetchPage
    });

    expect(opportunities.map((item) => item.title)).toEqual([
      "Growth Marketing Lead",
      "Product Marketing Manager"
    ]);
    expect(opportunities).toHaveLength(2);
    expect(opportunities.checkedAt).toBe(CHECKED_AT);
    expect(opportunities.warnings).toEqual([]);
    expect(opportunities[0]).toMatchObject({
      companyId: company.id,
      location: "Remote — US",
      sourceUrl: "https://jobs.acme.example/openings/growth-marketing-lead",
      checkedAt: CHECKED_AT,
      active: true
    });
    expect(opportunities[1]?.sourceUrl).toBe(
      "https://acme.example/jobs/product-marketing-manager"
    );
    expect(new Set(opportunities.map((item) => item.id)).size).toBe(2);
    expect(requestedUrls).toEqual([HOME_URL, CAREERS_URL]);
    expect(requestedUrls.some((url) => new URL(url).hostname.endsWith("linkedin.com"))).toBe(false);
  });

  it("uses configured locations and company industries as filters", async () => {
    const company = database.companies.upsert({
      ycId: "filter-jobs",
      name: "Filter Jobs",
      websiteUrl: CAREERS_URL,
      industry: "B2B / AI"
    });
    const careersHtml = await readFile(fixturePath, "utf8");
    const service = createJobDiscovery({
      repositories: database,
      fetchPage: async () => fetchedPage(CAREERS_URL, careersHtml, "Careers | Acme AI")
    });

    const remote = await service.findPmmOpportunities([company.id], {
      roleKeywords: ["marketing"],
      preferredLocations: ["Remote"],
      industries: ["AI"]
    });
    const wrongIndustry = await service.findPmmOpportunities([company.id], {
      roleKeywords: ["marketing"],
      preferredLocations: [],
      industries: ["Healthcare"]
    });

    expect(remote.map((item) => item.title)).toEqual(["Growth Marketing Lead"]);
    expect(wrongIndustry).toHaveLength(0);
  });

  it("returns successful jobs with a deterministic partial warning when another source fails", async () => {
    const workingCompany = database.companies.upsert({
      ycId: "working-jobs",
      name: "Working Jobs",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    });
    const failedCompany = database.companies.upsert({
      ycId: "failed-jobs",
      name: "Failed Jobs",
      websiteUrl: "https://failed.example/",
      industry: "AI"
    });
    const careersHtml = await readFile(fixturePath, "utf8");
    const service = createJobDiscovery({
      repositories: database,
      fetchPage: async (url) => {
        if (url === CAREERS_URL) {
          return fetchedPage(url, careersHtml, "Careers | Acme AI");
        }
        throw new Error("public page request failed with HTTP 503");
      }
    });

    const result = await service.findPmmOpportunities(
      [failedCompany.id, workingCompany.id],
      {
        roleKeywords: ["product marketing"],
        preferredLocations: ["San Francisco"],
        industries: ["AI"]
      }
    );

    expect(result.map((item) => item.title)).toEqual(["Product Marketing Manager"]);
    expect(result.warnings).toEqual([{
      sourceUrl: "https://failed.example/",
      message: "public page request failed with HTTP 503"
    }]);
  });

  it("treats invalid source freshness as a partial source failure", async () => {
    const company = database.companies.upsert({
      ycId: "invalid-job-time",
      name: "Invalid Job Time",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    });
    const careersHtml = await readFile(fixturePath, "utf8");
    const service = createJobDiscovery({
      repositories: database,
      now: () => new Date("2026-07-16T15:00:00.000Z"),
      fetchPage: async () => ({
        ...fetchedPage(CAREERS_URL, careersHtml, "Careers | Acme AI"),
        checkedAt: "not-a-time"
      })
    });

    const result = await service.findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: [],
      industries: []
    });

    expect(result).toHaveLength(0);
    expect(result.checkedAt).toBe("2026-07-16T15:00:00.000Z");
    expect(result.warnings[0]).toMatchObject({ sourceUrl: CAREERS_URL });
    expect(result.warnings[0]?.message).toMatch(/checkedAt.*ISO/i);
  });
});
