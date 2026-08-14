import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestCareerDatabase } from "../support/database.js";
import type { FetchedPage } from "../../src/research/fetch-page.js";
import * as jobDiscoveryModule from "../../src/research/job-discovery.js";
import { createJobDiscovery } from "../../src/research/job-discovery.js";

const fixturePath = fileURLToPath(new URL("../fixtures/company-careers.html", import.meta.url));
const CHECKED_AT = "2026-07-16T14:00:00.000Z";
const HOME_URL = "https://acme.example/";
const CAREERS_URL = "https://acme.example/careers";
const publicDns = async () => ["93.184.216.34"];
const database: TestCareerDatabase = await createTestDatabase();

afterEach(async () => (await database.resetForTests()));
afterAll(async () => (await database.close()));

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
  it("exports an explicit injected service factory without a misleading dependency-taking free function", () => {
    expect(Object.keys(jobDiscoveryModule).sort()).toEqual(["createJobDiscovery"]);
  });

  it("finds configured active marketing roles from official careers HTML", async () => {
    const company = (await database.companies.upsert({
      ycId: "acme-ai-jobs",
      name: "Acme AI",
      websiteUrl: HOME_URL,
      industry: "B2B / AI"
    }));
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

    const opportunities = await createJobDiscovery({
      repositories: database,
      resolveAddresses: publicDns,
      fetchPage
    }).findPmmOpportunities([company.id], preferences);

    expect(opportunities.opportunities.map((item) => item.title)).toEqual([
      "Growth Marketing Lead",
      "Product Marketing Manager"
    ]);
    expect(opportunities.opportunities).toHaveLength(2);
    expect(opportunities.checkedAt).toBe(CHECKED_AT);
    expect(opportunities.warnings).toEqual([]);
    expect(opportunities.opportunities[0]).toMatchObject({
      companyId: company.id,
      location: "Remote — US",
      sourceUrl: "https://jobs.acme.example/openings/growth-marketing-lead",
      checkedAt: CHECKED_AT,
      active: true
    });
    expect(opportunities.opportunities[1]?.sourceUrl).toBe(
      "https://acme.example/jobs/product-marketing-manager"
    );
    expect(new Set(opportunities.opportunities.map((item) => item.id)).size).toBe(2);
    expect(requestedUrls).toEqual([HOME_URL, CAREERS_URL]);
    expect(requestedUrls.some((url) => new URL(url).hostname.endsWith("linkedin.com"))).toBe(false);
  });

  it("uses configured locations and company industries as filters", async () => {
    const company = (await database.companies.upsert({
      ycId: "filter-jobs",
      name: "Filter Jobs",
      websiteUrl: CAREERS_URL,
      industry: "B2B / AI"
    }));
    const careersHtml = await readFile(fixturePath, "utf8");
    const service = createJobDiscovery({
      repositories: database,
      resolveAddresses: publicDns,
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

    expect(remote.opportunities.map((item) => item.title)).toEqual(["Growth Marketing Lead"]);
    expect(wrongIndustry.opportunities).toHaveLength(0);
  });

  it("parses conventional semantic job cards without fixture-only data attributes", async () => {
    const company = (await database.companies.upsert({
      ycId: "semantic-jobs",
      name: "Semantic Jobs",
      websiteUrl: HOME_URL,
      industry: "AI"
    }));
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      if (url === HOME_URL) {
        return fetchedPage(url, '<nav><a href="/careers">Careers</a></nav>', "Company");
      }
      return fetchedPage(url, `
        <section class="openings">
          <article class="job-listing">
            <h2>Product Marketing Manager</h2>
            <p class="location">Remote — US</p>
            <a href="/jobs/product-marketing-manager">View job</a>
          </article>
        </section>
      `, "Careers");
    };

    const result = await createJobDiscovery({
      repositories: database,
      fetchPage
    }).findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: ["Remote"],
      industries: ["AI"]
    });

    expect(result.opportunities.map(({ title }) => title)).toEqual(["Product Marketing Manager"]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects non-public job citations and DNS-to-private ATS hosts while retaining a public ATS", async () => {
    const company = (await database.companies.upsert({
      ycId: "public-job-citations",
      name: "Public Job Citations",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    }));
    const resolvedHosts: string[] = [];
    const result = await createJobDiscovery({
      repositories: database,
      resolveAddresses: async (hostname: string) => {
        resolvedHosts.push(hostname);
        return hostname === "private-ats.example" ? ["10.0.0.8"] : ["93.184.216.34"];
      },
      fetchPage: async (url) => fetchedPage(url, `
        <article class="job-card"><h2>Product Marketing Loopback</h2><a href="http://127.0.0.1/job">View</a></article>
        <article class="job-card"><h2>Product Marketing Private</h2><a href="http://10.2.3.4/job">View</a></article>
        <article class="job-card"><h2>Product Marketing Link Local</h2><a href="http://169.254.169.254/job">View</a></article>
        <article class="job-card"><h2>Product Marketing Localhost</h2><a href="http://localhost/job">View</a></article>
        <article class="job-card"><h2>Product Marketing Credentials</h2><a href="https://user:password@jobs.example/job">View</a></article>
        <article class="job-card"><h2>Product Marketing Private DNS</h2><a href="https://private-ats.example/job">View</a></article>
        <article class="job-card"><h2>Product Marketing Public ATS</h2><a href="https://public-ats.example/job">View</a></article>
        <article class="job-card"><h2>Product Marketing LinkedIn</h2><a href="https://www.linkedin.com/jobs/1">View</a></article>
      `, "Careers")
    }).findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: [],
      industries: ["AI"]
    });

    expect(result.opportunities.map(({ title, sourceUrl }) => ({ title, sourceUrl }))).toEqual([{
      title: "Product Marketing Public ATS",
      sourceUrl: "https://public-ats.example/job"
    }]);
    expect(resolvedHosts.sort()).toEqual(["private-ats.example", "public-ats.example"]);
    expect(result.warnings.filter(({ code }) => code === "invalid-data")).toHaveLength(7);
  });

  it("returns a source-changed partial warning for an unrecognized discovered careers page", async () => {
    const company = (await database.companies.upsert({
      ycId: "changed-job-layout",
      name: "Changed Job Layout",
      websiteUrl: HOME_URL,
      industry: "AI"
    }));
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      if (url === HOME_URL) {
        return fetchedPage(url, '<a href="/careers">Careers</a>', "Company");
      }
      return fetchedPage(url, "<main><h1>Open positions</h1><div>Layout version 99</div></main>", "Careers");
    };

    const result = await createJobDiscovery({
      repositories: database,
      fetchPage
    }).findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: [],
      industries: []
    });

    expect(result.opportunities).toEqual([]);
    expect(result.warnings).toEqual([{
      code: "source-changed",
      sourceUrl: CAREERS_URL,
      message: "Official careers page has no recognized job-listing structure"
    }]);
  });

  it("returns successful jobs with a deterministic partial warning when another source fails", async () => {
    const workingCompany = (await database.companies.upsert({
      ycId: "working-jobs",
      name: "Working Jobs",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    }));
    const failedCompany = (await database.companies.upsert({
      ycId: "failed-jobs",
      name: "Failed Jobs",
      websiteUrl: "https://failed.example/",
      industry: "AI"
    }));
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

    expect(result.opportunities.map((item) => item.title)).toEqual(["Product Marketing Manager"]);
    expect(result.warnings).toEqual([{
      sourceUrl: "https://failed.example/",
      message: "public page request failed with HTTP 503"
    }]);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      opportunities: result.opportunities,
      warnings: result.warnings,
      checkedAt: result.checkedAt
    });
  });

  it("treats invalid source freshness as a partial source failure", async () => {
    const company = (await database.companies.upsert({
      ycId: "invalid-job-time",
      name: "Invalid Job Time",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    }));
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

    expect(result.opportunities).toHaveLength(0);
    expect(result.checkedAt).toBe("2026-07-16T15:00:00.000Z");
    expect(result.warnings[0]).toMatchObject({ sourceUrl: CAREERS_URL });
    expect(result.warnings[0]?.message).toMatch(/checkedAt.*ISO/i);
  });

  it("bounds official careers-page fan-out per company and reports truncation", async () => {
    const company = (await database.companies.upsert({
      ycId: "bounded-careers",
      name: "Bounded Careers",
      websiteUrl: HOME_URL,
      industry: "AI"
    }));
    const requestedUrls: string[] = [];
    const links = Array.from({ length: 30 }, (_value, index) => {
      return `<a href="/careers-${index}">Careers ${index}</a>`;
    }).join("");
    const service = createJobDiscovery({
      repositories: database,
      budgets: {
        maxOfficialPagesPerCompany: 2,
        maxTotalRequestsPerCompany: 2,
        maxElapsedMsPerCompany: 1_000
      },
      fetchPage: async (url) => {
        requestedUrls.push(url);
        if (url === HOME_URL) {
          return fetchedPage(url, links, "Company");
        }
        return fetchedPage(url, `
          <article class="job-listing">
            <h2>Product Marketing Manager</h2>
            <p class="location">Remote</p>
            <a href="${url}/pmm">View job</a>
          </article>
        `, "Careers");
      }
    });

    const result = await service.findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: ["Remote"],
      industries: ["AI"]
    });

    expect(requestedUrls).toEqual([HOME_URL, "https://acme.example/careers-0"]);
    expect(result.opportunities).toHaveLength(1);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: HOME_URL,
      message: "Official careers page budget truncated 30 candidates to 2"
    });
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: HOME_URL,
      message: "Careers discovery total request budget of 2 was exhausted"
    });
  });

  it("skips oversized job titles and URLs with explicit invalid-data warnings", async () => {
    const company = (await database.companies.upsert({
      ycId: "bounded-job-fields",
      name: "Bounded Job Fields",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    }));
    const service = createJobDiscovery({
      repositories: database,
      fetchPage: async () => fetchedPage(CAREERS_URL, `
        <article class="job-listing">
          <h2>${"T".repeat(241)} product marketing</h2>
          <p class="location">Remote</p><a href="/jobs/long-title">View job</a>
        </article>
        <article class="job-listing">
          <h2>Product Marketing Manager</h2><p class="location">Remote</p>
          <a href="https://jobs.example/${"u".repeat(2_100)}">View job</a>
        </article>
      `, "Careers")
    });

    const result = await service.findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: ["Remote"],
      industries: ["AI"]
    });

    expect(result.opportunities).toEqual([]);
    expect(result.warnings.filter(({ code }) => code === "invalid-data")).toHaveLength(2);
    expect(result.warnings.map(({ message }) => message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/job title exceeds/i),
      expect.stringMatching(/job URL exceeds/i)
    ]));
  });

  it("accepts stale careers evidence with a warning and rejects future-dated evidence", async () => {
    const staleCompany = (await database.companies.upsert({
      ycId: "stale-job-source",
      name: "Stale Job Source",
      websiteUrl: "https://stale.example/careers",
      industry: "AI"
    }));
    const futureCompany = (await database.companies.upsert({
      ycId: "future-job-source",
      name: "Future Job Source",
      websiteUrl: "https://future.example/careers",
      industry: "AI"
    }));
    const service = createJobDiscovery({
      repositories: database,
      now: () => new Date("2026-07-16T14:00:00.000Z"),
      fetchPage: async (url) => ({
        ...fetchedPage(url, `
          <article class="job-listing">
            <h2>Product Marketing Manager</h2><p class="location">Remote</p>
            <a href="/jobs/pmm">View job</a>
          </article>
        `, "Careers"),
        checkedAt: url.includes("stale")
          ? "2026-05-01T00:00:00.000Z"
          : "2026-07-16T14:06:00.000Z"
      })
    });

    const result = await service.findPmmOpportunities([staleCompany.id, futureCompany.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: ["Remote"],
      industries: ["AI"]
    });

    expect(result.opportunities.map(({ companyId }) => companyId)).toEqual([staleCompany.id]);
    expect(result.warnings).toContainEqual({
      code: "stale-source",
      sourceUrl: "https://stale.example/careers",
      message: "Official careers source is older than the 30-day freshness policy"
    });
    expect(result.warnings).toContainEqual({
      code: "invalid-data",
      sourceUrl: "https://future.example/careers",
      message: "Official careers source checkedAt exceeds the 5-minute future-skew allowance"
    });
  });

  it("reports aggregate elapsed-budget exhaustion even when the initial careers page has jobs", async () => {
    const company = (await database.companies.upsert({
      ycId: "elapsed-root-jobs",
      name: "Elapsed Root Jobs",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    }));
    let elapsedMs = 0;
    const service = createJobDiscovery({
      repositories: database,
      elapsedNow: () => elapsedMs,
      budgets: { maxElapsedMsPerCompany: 1_000 },
      fetchPage: async () => {
        elapsedMs = 1_100;
        return fetchedPage(CAREERS_URL, `
          <article class="job-listing">
            <h2>Product Marketing Manager</h2><p class="location">Remote</p>
            <a href="/jobs/pmm">View job</a>
          </article>
        `, "Careers");
      }
    });

    const result = await service.findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: ["Remote"],
      industries: ["AI"]
    });

    expect(result.opportunities).toHaveLength(1);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: CAREERS_URL,
      message: "Careers discovery elapsed-time budget of 1000ms was exhausted"
    });
  });

  it("returns at the company deadline when an injected careers fetch ignores cancellation", async () => {
    const company = (await database.companies.upsert({
      ycId: "hard-fetch-deadline-jobs",
      name: "Hard Fetch Deadline Jobs",
      websiteUrl: CAREERS_URL,
      industry: "AI"
    }));
    let adapterCompleted = false;
    let receivedSignal: AbortSignal | undefined;
    let adapterSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      adapterSettled = resolve;
    });
    const result = await createJobDiscovery({
      repositories: database,
      budgets: { maxElapsedMsPerCompany: 20 },
      fetchPage: async (url, options?: { signal: AbortSignal; timeoutMs: number }) => {
        receivedSignal = options?.signal;
        await new Promise((resolve) => setTimeout(resolve, 80));
        adapterCompleted = true;
        adapterSettled();
        return fetchedPage(url, `
          <article class="job-card"><h2>Product Marketing Too Late</h2><a href="/job">View</a></article>
        `, "Careers");
      }
    }).findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: [],
      industries: ["AI"]
    });
    expect(adapterCompleted).toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.opportunities).toEqual([]);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: CAREERS_URL,
      message: "Careers discovery elapsed-time budget of 20ms was exhausted"
    });
    await settled;
  });

  it("rejects an oversized official careers candidate URL before fetching", async () => {
    const company = (await database.companies.upsert({
      ycId: "oversized-official-job-url",
      name: "Oversized Official Job URL",
      websiteUrl: HOME_URL,
      industry: "AI"
    }));
    const requestedUrls: string[] = [];
    const service = createJobDiscovery({
      repositories: database,
      fetchPage: async (url) => {
        requestedUrls.push(url);
        return fetchedPage(url, `
          <a href="/careers-${"u".repeat(2_100)}">Careers</a>
        `, "Company");
      }
    });

    const result = await service.findPmmOpportunities([company.id], {
      roleKeywords: ["product marketing"],
      preferredLocations: [],
      industries: ["AI"]
    });

    expect(requestedUrls).toEqual([HOME_URL]);
    expect(result.warnings).toContainEqual({
      code: "invalid-data",
      sourceUrl: HOME_URL,
      message: "Official careers candidate URL exceeds 2048 characters or 4096 UTF-8 bytes"
    });
  });
});
