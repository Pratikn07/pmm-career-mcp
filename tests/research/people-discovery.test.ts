import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestCareerDatabase } from "../support/database.js";
import { postgresErrorKind } from "../../src/domain/errors.js";
import type { FetchedPage } from "../../src/research/fetch-page.js";
import * as peopleDiscoveryModule from "../../src/research/people-discovery.js";
import { createPeopleDiscovery } from "../../src/research/people-discovery.js";
import {
  DisabledSearchProvider,
  type SearchProvider
} from "../../src/research/search-provider.js";

const fixturePath = fileURLToPath(new URL("../fixtures/company-team.html", import.meta.url));
const CHECKED_AT = "2026-07-16T13:00:00.000Z";
const HOME_URL = "https://acme.example/";
const TEAM_URL = "https://acme.example/team";
const database: TestCareerDatabase = await createTestDatabase();

afterEach(async () => (await database.resetForTests()));
afterAll(async () => (await database.close()));

function fetchedPage(url: string, html: string, title: string): FetchedPage {
  return {
    url,
    title,
    text: "Synthetic visible public company page text",
    html,
    checkedAt: CHECKED_AT,
    contentType: "text/html",
    untrusted: true
  };
}

describe("public people discovery", () => {
  it("exports an explicit injected service factory without a misleading dependency-taking free function", () => {
    expect(Object.keys(peopleDiscoveryModule).sort()).toEqual(["createPeopleDiscovery"]);
  });

  it("discovers, normalizes, deduplicates, and persists people from official pages", async () => {
    const company = (await database.companies.upsert({
      ycId: "acme-ai",
      name: "Acme AI",
      websiteUrl: HOME_URL,
      checkedAt: "2026-07-15T00:00:00.000Z"
    }));
    const teamHtml = await readFile(fixturePath, "utf8");
    const requestedUrls: string[] = [];
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      requestedUrls.push(url);
      if (url === HOME_URL) {
        return fetchedPage(url, `
          <html><body><nav>
            <a href="/team">Team</a>
            <a href="https://outside.example/team">Partner team</a>
            <a href="https://www.linkedin.com/company/acme-ai">LinkedIn</a>
          </nav></body></html>
        `, "Acme AI");
      }
      if (url === TEAM_URL) {
        return fetchedPage(url, teamHtml, "Team | Acme AI");
      }
      throw new Error(`Unexpected page request: ${url}`);
    };
    const service = createPeopleDiscovery({ repositories: database, fetchPage });

    const result = await service.discoverPublicPeople(company.id);

    expect(result.coverage).toBe("authoritative-pages-only");
    expect(result.checkedAt).toBe(CHECKED_AT);
    expect(result.warnings).toEqual([]);
    expect(result.people.map(({ name, role }) => `${name} — ${role}`)).toEqual([
      "Ada Example — Co-founder & CEO",
      "Kai Brooks — Staff Software Engineer",
      "Maya Chen — VP, Product Marketing",
      "Priya Rao — Recruiting Lead"
    ]);
    expect(result.people).toHaveLength(4);
    for (const person of result.people) {
      expect(person).toMatchObject({
        companyId: company.id,
        checkedAt: CHECKED_AT,
        confidence: 0.95
      });
      expect(person.name).not.toBe("");
      expect(person.role).not.toBe("");
      expect(person.evidence).toHaveLength(1);
      expect(person.evidence[0]).toMatchObject({
        sourceUrl: TEAM_URL,
        url: TEAM_URL,
        checkedAt: CHECKED_AT,
        confidence: 0.95
      });
    }
    expect(result.people.find(({ name }) => name === "Ada Example")?.publicProfileUrl).toBe(
      "https://www.linkedin.com/in/ada-example"
    );
    expect(result.people.find(({ name }) => name === "Priya Rao")?.publicProfileUrl).toBeUndefined();
    expect(requestedUrls).toEqual([HOME_URL, TEAM_URL]);
    expect(requestedUrls.some((url) => new URL(url).hostname.endsWith("linkedin.com"))).toBe(false);
    expect((await database.people.listByCompany(company.id))).toHaveLength(4);
    expect(result.evidence).toHaveLength(4);
    expect(result.evidence.every(({ fact }) => fact.length < 100)).toBe(true);
    expect(result.evidence.map(({ fact }) => fact)).not.toContain(
      expect.stringContaining("large suite of workflow products")
    );
    for (const person of result.people) {
      const persisted = (await database.people.getWithEvidence(person.id));
      expect(persisted?.evidence).toHaveLength(1);
      expect(persisted?.evidence[0]?.fact).toBe(`${person.name} — ${person.role}`);
      expect(persisted?.evidence[0]?.fact).not.toContain("large suite of workflow products");
    }
  });

  it("projects hardened official people without persisting discovery rows", async () => {
    const company = await database.companies.upsert({
      ycId: "project-official-people",
      name: "Project Official People",
      websiteUrl: TEAM_URL,
      checkedAt: "2026-07-15T00:00:00.000Z"
    });
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async (url) => fetchedPage(url, `
        <article class="team-member">
          <h2>Ada Projection</h2><p>Co-founder & CEO</p>
          <a href="https://www.linkedin.com/in/ada-projection">LinkedIn</a>
        </article>
      `, "Team")
    });

    const result = await service.projectOfficialPeople(company.id);

    expect(result.people).toEqual([expect.objectContaining({
      companyId: company.id,
      name: "Ada Projection",
      role: "Co-founder & CEO",
      publicProfileUrl: "https://www.linkedin.com/in/ada-projection",
      evidence: [expect.objectContaining({
        sourceKind: "OFFICIAL_COMPANY",
        sourceUrl: TEAM_URL,
        checkedAt: CHECKED_AT
      })]
    })]);
    expect(await database.people.listByCompany(company.id)).toEqual([]);
  });

  it("returns successful official-page findings with a partial warning when another source fails", async () => {
    const company = (await database.companies.upsert({
      ycId: "partial-people",
      name: "Partial People",
      websiteUrl: HOME_URL
    }));
    const teamHtml = await readFile(fixturePath, "utf8");
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      if (url === HOME_URL) {
        return fetchedPage(url, `
          <a href="/team">Team</a><a href="/leadership">Leadership</a>
        `, "Acme AI");
      }
      if (url === TEAM_URL) {
        return fetchedPage(url, teamHtml, "Team | Acme AI");
      }
      throw new Error("public page request failed with HTTP 503");
    };

    const result = await createPeopleDiscovery({
      repositories: database,
      fetchPage
    }).discoverPublicPeople(company.id);

    expect(result.people).toHaveLength(4);
    expect(result.warnings).toEqual([{
      sourceUrl: "https://acme.example/leadership",
      message: "public page request failed with HTTP 503"
    }]);
  });

  it("parses conventional semantic team cards without fixture-only data attributes", async () => {
    const company = (await database.companies.upsert({
      ycId: "semantic-people",
      name: "Semantic People",
      websiteUrl: HOME_URL
    }));
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      if (url === HOME_URL) {
        return fetchedPage(url, '<nav><a href="/leadership">Leadership</a></nav>', "Company");
      }
      return fetchedPage(url, `
        <main>
          <article class="team-member">
            <h2>Ada Semantic</h2>
            <p class="role">Chief Executive Officer</p>
            <a href="https://www.linkedin.com/in/ada-semantic">LinkedIn</a>
          </article>
          <article class="person-card">
            <h3>Maya Semantic</h3>
            <div class="job-title">VP Product Marketing</div>
          </article>
        </main>
      `, "Leadership");
    };

    const result = await createPeopleDiscovery({
      repositories: database,
      fetchPage
    }).discoverPublicPeople(company.id);

    expect(result.people.map(({ name, role }) => `${name} — ${role}`)).toEqual([
      "Ada Semantic — Chief Executive Officer",
      "Maya Semantic — VP Product Marketing"
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("retains a sanitized non-fetching LinkedIn profile reference without requesting it", async () => {
    const company = (await database.companies.upsert({
      ycId: "non-fetching-profile-reference",
      name: "Non-fetching Profile Reference",
      websiteUrl: TEAM_URL
    }));
    const requestedUrls: string[] = [];
    const result = await createPeopleDiscovery({
      repositories: database,
      fetchPage: async (url) => {
        requestedUrls.push(url);
        return fetchedPage(url, `
          <article class="team-member">
            <h2>Ada Reference</h2><p>Founder</p>
            <a data-non-fetching-profile-url="https://www.linkedin.com/in/ada-reference">
              LinkedIn
            </a>
          </article>
        `, "Team");
      }
    }).discoverPublicPeople(company.id);

    expect(result.people[0]?.publicProfileUrl).toBe(
      "https://www.linkedin.com/in/ada-reference"
    );
    expect(requestedUrls).toEqual([TEAM_URL]);
  });

  it("returns a source-changed partial warning for an unrecognized discovered team page", async () => {
    const company = (await database.companies.upsert({
      ycId: "changed-people-layout",
      name: "Changed People Layout",
      websiteUrl: HOME_URL
    }));
    const fetchPage = async (url: string): Promise<FetchedPage> => {
      if (url === HOME_URL) {
        return fetchedPage(url, '<a href="/team">Team</a>', "Company");
      }
      return fetchedPage(url, "<main><h1>Meet everyone</h1><div>Layout version 99</div></main>", "Team");
    };

    const result = await createPeopleDiscovery({
      repositories: database,
      fetchPage
    }).discoverPublicPeople(company.id);

    expect(result.people).toEqual([]);
    expect(result.warnings).toEqual([{
      code: "source-changed",
      sourceUrl: TEAM_URL,
      message: "Official people page has no recognized team or leadership structure"
    }]);
  });

  it("rejects discovery when the stored company has no official website", async () => {
    const company = (await database.companies.upsert({ ycId: "no-site", name: "No Site" }));

    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async () => {
        throw new Error("should not fetch");
      }
    });

    await expect(service.discoverPublicPeople(company.id)).rejects.toThrow(/official website/i);
  });

  it("uses a disabled search provider without network work and reports authoritative coverage", async () => {
    const provider = new DisabledSearchProvider();

    expect(provider.coverage).toBe("authoritative-pages-only");
    await expect(provider.search("site:acme.example team", 10, {
      signal: AbortSignal.timeout(20),
      timeoutMs: 20
    })).resolves.toEqual([]);
  });

  it("starts with the official site and does not retain LinkedIn links from search-extended pages", async () => {
    const company = (await database.companies.upsert({
      ycId: "search-extended-people",
      name: "Search Extended People",
      websiteUrl: HOME_URL
    }));
    const events: string[] = [];
    const searchProvider: SearchProvider = {
      coverage: "search-extended",
      search: async () => {
        events.push("search");
        return [{
          title: "Acme leadership interview",
          url: "https://press.example/acme-team",
          snippet: "Public interview",
          checkedAt: CHECKED_AT
        }];
      }
    };
    const service = createPeopleDiscovery({
      repositories: database,
      searchProvider,
      fetchPage: async (url) => {
        events.push(`fetch:${url}`);
        if (url === HOME_URL) {
          return fetchedPage(url, "<main><h1>Acme AI</h1></main>", "Acme AI");
        }
        return fetchedPage(url, `
          <article data-team-member>
            <h2 data-person-name>External Example</h2>
            <p data-person-role>Advisor</p>
            <a href="https://www.linkedin.com/in/external-example">LinkedIn</a>
          </article>
        `, "Acme leadership interview");
      }
    });

    const projection = await service.projectOfficialPeople(company.id);

    expect(projection.people).toEqual([]);
    expect(await database.people.listByCompany(company.id)).toEqual([]);
    expect(events).toEqual([
      `fetch:${HOME_URL}`,
      "search",
      "fetch:https://press.example/acme-team"
    ]);
    events.length = 0;

    const result = await service.discoverPublicPeople(company.id);

    expect(result.coverage).toBe("search-extended");
    expect(result.people[0]).toMatchObject({ name: "External Example", role: "Advisor" });
    expect(result.people[0]?.publicProfileUrl).toBeUndefined();
    expect(events).toEqual([
      `fetch:${HOME_URL}`,
      "search",
      "fetch:https://press.example/acme-team"
    ]);
  });

  it("bounds official people-page fan-out and reports deterministic truncation", async () => {
    const company = (await database.companies.upsert({
      ycId: "bounded-official-people",
      name: "Bounded Official People",
      websiteUrl: HOME_URL
    }));
    const requestedUrls: string[] = [];
    const links = Array.from({ length: 30 }, (_value, index) => {
      return `<a href="/team-${index}">Team ${index}</a>`;
    }).join("");
    const service = createPeopleDiscovery({
      repositories: database,
      budgets: {
        maxOfficialPagesPerCompany: 2,
        maxSearchResultsPerCompany: 2,
        maxTotalRequestsPerCompany: 4,
        maxElapsedMsPerCompany: 1_000
      },
      fetchPage: async (url) => {
        requestedUrls.push(url);
        if (url === HOME_URL) {
          return fetchedPage(url, links, "Company");
        }
        const suffix = new URL(url).pathname.split("-").at(-1);
        return fetchedPage(url, `
          <article class="team-member"><h2>Person ${suffix}</h2><p>Founder</p></article>
        `, "Team");
      }
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(requestedUrls).toEqual([HOME_URL, "https://acme.example/team-0", "https://acme.example/team-1"]);
    expect(result.people).toHaveLength(2);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: HOME_URL,
      message: "Official people page budget truncated 30 candidates to 2"
    });
  });

  it("slices over-returned search results and enforces aggregate elapsed time", async () => {
    const company = (await database.companies.upsert({
      ycId: "bounded-search-people",
      name: "Bounded Search People",
      websiteUrl: HOME_URL
    }));
    let elapsedMs = 0;
    const requestedUrls: string[] = [];
    const searchProvider: SearchProvider = {
      coverage: "search-extended",
      search: async () => Array.from({ length: 20 }, (_value, index) => ({
        title: `Person result ${index}`,
        url: `https://press.example/person-${index}`,
        snippet: "Public profile",
        checkedAt: CHECKED_AT
      }))
    };
    const service = createPeopleDiscovery({
      repositories: database,
      searchProvider,
      elapsedNow: () => elapsedMs,
      budgets: {
        maxOfficialPagesPerCompany: 2,
        maxSearchResultsPerCompany: 2,
        maxTotalRequestsPerCompany: 5,
        maxElapsedMsPerCompany: 1_000
      },
      fetchPage: async (url) => {
        requestedUrls.push(url);
        elapsedMs += 600;
        if (url === HOME_URL) {
          return fetchedPage(url, "<main>Company</main>", "Company");
        }
        return fetchedPage(url, `
          <article class="person-card"><h2>Search Person</h2><p>Advisor</p></article>
        `, "Public profile");
      }
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(requestedUrls).toEqual([HOME_URL, "https://press.example/person-0"]);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: HOME_URL,
      message: "Search result budget truncated 20 results to 2"
    });
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: HOME_URL,
      message: "People discovery elapsed-time budget of 1000ms was exhausted"
    });
  });

  it("reports aggregate elapsed-budget exhaustion after the initial people page", async () => {
    const company = (await database.companies.upsert({
      ycId: "elapsed-root-people",
      name: "Elapsed Root People",
      websiteUrl: TEAM_URL
    }));
    let elapsedMs = 0;
    const service = createPeopleDiscovery({
      repositories: database,
      elapsedNow: () => elapsedMs,
      budgets: {
        maxOfficialPagesPerCompany: 2,
        maxSearchResultsPerCompany: 2,
        maxTotalRequestsPerCompany: 4,
        maxElapsedMsPerCompany: 1_000
      },
      fetchPage: async (url) => {
        elapsedMs = 1_100;
        return fetchedPage(url, `
          <article class="team-member"><h2>Root Person</h2><p>Founder</p></article>
        `, "Team");
      }
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(result.people).toHaveLength(1);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: TEAM_URL,
      message: "People discovery elapsed-time budget of 1000ms was exhausted"
    });
  });

  it("returns at the company deadline when an injected fetch adapter ignores cancellation", async () => {
    const company = (await database.companies.upsert({
      ycId: "hard-fetch-deadline-people",
      name: "Hard Fetch Deadline People",
      websiteUrl: TEAM_URL
    }));
    let adapterCompleted = false;
    let receivedSignal: AbortSignal | undefined;
    let adapterSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      adapterSettled = resolve;
    });
    const result = await createPeopleDiscovery({
      repositories: database,
      budgets: { maxElapsedMsPerCompany: 20 },
      fetchPage: async (url, options?: { signal: AbortSignal; timeoutMs: number }) => {
        receivedSignal = options?.signal;
        await new Promise((resolve) => setTimeout(resolve, 80));
        adapterCompleted = true;
        adapterSettled();
        return fetchedPage(url, `
          <article class="team-member"><h2>Too Late</h2><p>Founder</p></article>
        `, "Team");
      }
    }).discoverPublicPeople(company.id);
    expect(adapterCompleted).toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.people).toEqual([]);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: TEAM_URL,
      message: "People discovery elapsed-time budget of 20ms was exhausted"
    });
    await settled;
  });

  it("returns at the company deadline when a search adapter ignores cancellation", async () => {
    const company = (await database.companies.upsert({
      ycId: "hard-search-deadline-people",
      name: "Hard Search Deadline People",
      websiteUrl: HOME_URL
    }));
    let adapterCompleted = false;
    let receivedSignal: AbortSignal | undefined;
    let adapterSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      adapterSettled = resolve;
    });
    const searchProvider = {
      coverage: "search-extended" as const,
      search: async (
        _query: string,
        _limit: number,
        options?: { signal: AbortSignal; timeoutMs: number }
      ) => {
        receivedSignal = options?.signal;
        await new Promise((resolve) => setTimeout(resolve, 80));
        adapterCompleted = true;
        adapterSettled();
        return [];
      }
    };
    const result = await createPeopleDiscovery({
      repositories: database,
      searchProvider,
      budgets: { maxElapsedMsPerCompany: 20 },
      fetchPage: async (url) => fetchedPage(url, "<main>Company</main>", "Company")
    }).discoverPublicPeople(company.id);
    expect(adapterCompleted).toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.people).toEqual([]);
    expect(result.warnings).toContainEqual({
      code: "budget-exhausted",
      sourceUrl: HOME_URL,
      message: "People discovery elapsed-time budget of 20ms was exhausted"
    });
    await settled;
  });

  it("skips oversized names, roles, facts, and profile URLs before database writes", async () => {
    const company = (await database.companies.upsert({
      ycId: "bounded-person-fields",
      name: "Bounded Person Fields",
      websiteUrl: TEAM_URL
    }));
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async () => fetchedPage(TEAM_URL, `
        <article class="team-member"><h2>${"N".repeat(161)}</h2><p>Founder</p></article>
        <article class="team-member"><h2>Role Example</h2><p>${"R".repeat(241)}</p></article>
        <article class="team-member"><h2>${"F".repeat(150)}</h2><p>${"P".repeat(170)}</p></article>
        <article class="team-member">
          <h2>Profile Example</h2><p>Founder</p>
          <a href="https://www.linkedin.com/in/${"u".repeat(2_100)}">LinkedIn</a>
        </article>
      `, "Team")
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(result.people).toEqual([]);
    expect((await database.people.listByCompany(company.id))).toEqual([]);
    expect(result.warnings.filter(({ code }) => code === "invalid-data")).toHaveLength(4);
    expect(result.warnings.map(({ message }) => message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/name exceeds/i),
      expect.stringMatching(/role exceeds/i),
      expect.stringMatching(/evidence fact exceeds/i),
      expect.stringMatching(/profile URL exceeds/i)
    ]));
  });

  it("accepts stale official evidence with an explicit age warning", async () => {
    const company = (await database.companies.upsert({
      ycId: "stale-people-source",
      name: "Stale People Source",
      websiteUrl: TEAM_URL
    }));
    const service = createPeopleDiscovery({
      repositories: database,
      now: () => new Date("2026-07-16T13:00:00.000Z"),
      fetchPage: async () => ({
        ...fetchedPage(TEAM_URL, `
          <article class="team-member"><h2>Stale Example</h2><p>Founder</p></article>
        `, "Team"),
        checkedAt: "2026-05-01T00:00:00.000Z"
      })
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(result.people.map(({ name }) => name)).toEqual(["Stale Example"]);
    expect(result.warnings).toContainEqual({
      code: "stale-source",
      sourceUrl: TEAM_URL,
      message: "Public people source is older than the 30-day freshness policy"
    });
  });

  it("rejects future-dated official evidence before database writes", async () => {
    const company = (await database.companies.upsert({
      ycId: "future-people-source",
      name: "Future People Source",
      websiteUrl: TEAM_URL
    }));
    const service = createPeopleDiscovery({
      repositories: database,
      now: () => new Date("2026-07-16T13:00:00.000Z"),
      fetchPage: async () => ({
        ...fetchedPage(TEAM_URL, `
          <article class="team-member"><h2>Future Example</h2><p>Founder</p></article>
        `, "Team"),
        checkedAt: "2026-07-16T13:06:00.000Z"
      })
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(result.people).toEqual([]);
    expect((await database.people.listByCompany(company.id))).toEqual([]);
    expect(result.warnings).toContainEqual({
      code: "invalid-data",
      sourceUrl: TEAM_URL,
      message: "Public people source checkedAt exceeds the 5-minute future-skew allowance"
    });
  });

  it("validates stale and future timestamps supplied by a search adapter before fetching results", async () => {
    const company = (await database.companies.upsert({
      ycId: "dated-search-results",
      name: "Dated Search Results",
      websiteUrl: HOME_URL
    }));
    const requestedUrls: string[] = [];
    const searchProvider: SearchProvider = {
      coverage: "search-extended",
      search: async () => [{
        title: "Stale result",
        url: "https://press.example/stale-person",
        snippet: "Profile",
        checkedAt: "2026-05-01T00:00:00.000Z"
      }, {
        title: "Future result",
        url: "https://press.example/future-person",
        snippet: "Profile",
        checkedAt: "2026-07-16T13:06:00.000Z"
      }]
    };
    const service = createPeopleDiscovery({
      repositories: database,
      searchProvider,
      now: () => new Date("2026-07-16T13:00:00.000Z"),
      fetchPage: async (url) => {
        requestedUrls.push(url);
        if (url === HOME_URL) {
          return fetchedPage(url, "<main>Company</main>", "Company");
        }
        return fetchedPage(url, `
          <article class="person-card"><h2>Search Dated</h2><p>Advisor</p></article>
        `, "Profile");
      }
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(requestedUrls).toEqual([HOME_URL, "https://press.example/stale-person"]);
    expect(result.warnings).toContainEqual({
      code: "stale-source",
      sourceUrl: "https://press.example/stale-person",
      message: "Search result is older than the 30-day freshness policy"
    });
    expect(result.warnings).toContainEqual({
      code: "invalid-data",
      sourceUrl: "https://press.example/future-person",
      message: "Search result checkedAt exceeds the 5-minute future-skew allowance"
    });
  });

  it("refreshes people and discovery evidence idempotently", async () => {
    const company = (await database.companies.upsert({
      ycId: "idempotent-people",
      name: "Idempotent People",
      websiteUrl: TEAM_URL
    }));
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async () => fetchedPage(TEAM_URL, `
        <article class="team-member"><h2>Ada Refresh</h2><p>Founder</p></article>
      `, "Team")
    });

    const first = await service.discoverPublicPeople(company.id);
    const second = await service.discoverPublicPeople(company.id);
    const persisted = (await database.people.getWithEvidence(first.people[0]!.id));

    expect(second.people[0]?.id).toBe(first.people[0]?.id);
    expect(second.people[0]?.evidence[0]?.id).toBe(first.people[0]?.evidence[0]?.id);
    expect(persisted?.evidence).toHaveLength(1);
  });

  it("clears current discovery state for a person absent from the next complete authoritative snapshot", async () => {
    const company = (await database.companies.upsert({
      ycId: "authoritative-person-disappearance",
      name: "Authoritative Person Disappearance",
      websiteUrl: TEAM_URL
    }));
    let html = `
      <article class="team-member">
        <h2>Ada Former</h2><p>Founder</p>
        <a href="https://www.linkedin.com/in/ada-former">LinkedIn</a>
      </article>
    `;
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async () => fetchedPage(TEAM_URL, html, "Team")
    });
    const first = await service.discoverPublicPeople(company.id);
    const adaId = first.people[0]!.id;
    html = `
      <article class="team-member"><h2>Bob Current</h2><p>Founder</p></article>
    `;

    const second = await service.discoverPublicPeople(company.id);
    const persistedAda = (await database.people.getWithEvidence(adaId));

    expect(second.people.map(({ name }) => name)).toEqual(["Bob Current"]);
    expect(persistedAda).toMatchObject({
      id: adaId,
      publicProfileUrl: null,
      checkedAt: null,
      evidence: []
    });
  });

  it("preserves prior discovery state when an authoritative refresh is only partially successful", async () => {
    const company = (await database.companies.upsert({
      ycId: "partial-authoritative-preservation",
      name: "Partial Authoritative Preservation",
      websiteUrl: HOME_URL
    }));
    let phase = 1;
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async (url) => {
        if (url === HOME_URL) {
          return fetchedPage(url, phase === 1
            ? '<a href="/team">Team</a>'
            : '<a href="/team">Team</a><a href="/leadership">Leadership</a>', "Company");
        }
        if (url === "https://acme.example/leadership") {
          throw new Error("leadership source failed");
        }
        return fetchedPage(url, phase === 1
          ? '<article class="team-member"><h2>Ada Preserved</h2><p>Founder</p></article>'
          : '<article class="team-member"><h2>Bob Partial</h2><p>CEO</p></article>', "Team");
      }
    });
    const first = await service.discoverPublicPeople(company.id);
    const adaId = first.people[0]!.id;
    phase = 2;

    const second = await service.discoverPublicPeople(company.id);
    const persistedAda = (await database.people.getWithEvidence(adaId));

    expect(second.people.map(({ name }) => name)).toEqual(["Bob Partial"]);
    expect(second.warnings).toContainEqual({
      sourceUrl: "https://acme.example/leadership",
      message: "leadership source failed"
    });
    expect(persistedAda?.evidence.map(({ fact }) => fact)).toEqual([
      "Ada Preserved — Founder"
    ]);
    expect(persistedAda?.checkedAt).toBe(CHECKED_AT);
  });

  it("preserves prior search-derived discovery state when the next optional-search page is invalid", async () => {
    const company = (await database.companies.upsert({
      ycId: "invalid-search-refresh-preservation",
      name: "Invalid Search Refresh Preservation",
      websiteUrl: TEAM_URL
    }));
    const searchUrl = "https://press.example/ada-search";
    let phase = 1;
    const service = createPeopleDiscovery({
      repositories: database,
      searchProvider: {
        coverage: "search-extended",
        search: async () => [{
          title: "Ada Search profile",
          url: searchUrl,
          snippet: "Public profile",
          checkedAt: CHECKED_AT
        }]
      },
      fetchPage: async (url) => {
        if (url === TEAM_URL) {
          return fetchedPage(url, `
            <article class="team-member"><h2>Official Current</h2><p>Founder</p></article>
          `, "Team");
        }
        return fetchedPage(url, phase === 1
          ? '<article class="person-card"><h2>Ada Search</h2><p>Advisor</p></article>'
          : `<article class="person-card"><h2>${"N".repeat(161)}</h2><p>Advisor</p></article>`,
        "Public profile");
      }
    });
    const first = await service.discoverPublicPeople(company.id);
    const adaId = first.people.find(({ name }) => name === "Ada Search")!.id;
    const priorAda = (await database.people.getWithEvidence(adaId))!;
    phase = 2;

    const second = await service.discoverPublicPeople(company.id);
    const persistedAda = (await database.people.getWithEvidence(adaId));

    expect(second.warnings).toContainEqual({
      code: "invalid-data",
      sourceUrl: searchUrl,
      message: "Skipped public person record because name exceeds 160 characters or 320 UTF-8 bytes"
    });
    expect(persistedAda?.checkedAt).toBe(priorAda.checkedAt);
    expect(persistedAda?.evidence).toEqual(priorAda.evidence);
  });

  it("normalizes persistent identity across case and whitespace drift and clears a removed profile link", async () => {
    const company = (await database.companies.upsert({
      ycId: "normalized-refresh-people",
      name: "Normalized Refresh People",
      websiteUrl: TEAM_URL
    }));
    let html = `
      <article class="team-member">
        <h2>Ada Example</h2><p>VP Product Marketing</p>
        <a href="https://www.linkedin.com/in/ada-example">LinkedIn</a>
      </article>
    `;
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async () => fetchedPage(TEAM_URL, html, "Team")
    });
    const first = await service.discoverPublicPeople(company.id);
    html = `
      <article class="team-member">
        <h2>  ada   example </h2><p> vp   product marketing </p>
      </article>
    `;

    const second = await service.discoverPublicPeople(company.id);
    const persisted = (await database.people.listByCompany(company.id));

    expect(persisted).toHaveLength(1);
    expect(second.people[0]?.id).toBe(first.people[0]?.id);
    expect(persisted[0]).toMatchObject({
      name: "ada example",
      role: "vp product marketing",
      publicProfileUrl: null
    });
  });

  it("rolls back an entire company refresh when one normalized identity cannot be updated", async () => {
    const company = (await database.companies.upsert({
      ycId: "rollback-refresh-people",
      name: "Rollback Refresh People",
      websiteUrl: TEAM_URL
    }));
    const aaron = (await database.people.upsert({
      companyId: company.id,
      name: "Aaron Changed",
      role: "Founder",
      publicProfileUrl: "https://www.linkedin.com/in/aaron-old"
    }));
    (await database.people.upsert({ companyId: company.id, name: "Ada  Example", role: "CEO" }));
    (await database.people.upsert({ companyId: company.id, name: "Ada Example", role: "CEO" }));
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async () => fetchedPage(TEAM_URL, `
        <article class="team-member">
          <h2>Aaron Changed</h2><p>Founder</p>
          <a href="https://www.linkedin.com/in/aaron-new">LinkedIn</a>
        </article>
        <article class="team-member"><h2>Ada Example</h2><p>CEO</p></article>
      `, "Team")
    });

    let persistenceError: unknown;
    try {
      await service.discoverPublicPeople(company.id);
    } catch (error) {
      persistenceError = error;
    }
    expect(postgresErrorKind(persistenceError)).toBe("unique");

    expect((await database.people.get(aaron.id))?.publicProfileUrl).toBe(
      "https://www.linkedin.com/in/aaron-old"
    );
    expect((await database.evidence.listForPerson(aaron.id))).toEqual([]);
  });

  it("rejects missing search freshness and oversized search URLs before fetching", async () => {
    const company = (await database.companies.upsert({
      ycId: "invalid-search-fields",
      name: "Invalid Search Fields",
      websiteUrl: HOME_URL
    }));
    const requestedUrls: string[] = [];
    const searchProvider = {
      coverage: "search-extended" as const,
      search: async () => [{
        title: "Missing timestamp",
        url: "https://press.example/missing-time",
        snippet: "Profile"
      }, {
        title: "Oversized URL",
        url: `https://press.example/${"u".repeat(2_100)}`,
        snippet: "Profile",
        checkedAt: CHECKED_AT
      }]
    } as SearchProvider;
    const service = createPeopleDiscovery({
      repositories: database,
      searchProvider,
      fetchPage: async (url) => {
        requestedUrls.push(url);
        return fetchedPage(url, "<main>Company</main>", "Company");
      }
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(requestedUrls).toEqual([HOME_URL]);
    expect(result.warnings.map(({ message }) => message)).toEqual(expect.arrayContaining([
      "Search result checkedAt is required",
      expect.stringMatching(/search result URL exceeds/i)
    ]));
  });

  it("rejects an oversized official people candidate URL before fetching", async () => {
    const company = (await database.companies.upsert({
      ycId: "oversized-official-person-url",
      name: "Oversized Official Person URL",
      websiteUrl: HOME_URL
    }));
    const requestedUrls: string[] = [];
    const service = createPeopleDiscovery({
      repositories: database,
      fetchPage: async (url) => {
        requestedUrls.push(url);
        return fetchedPage(url, `
          <a href="/team-${"u".repeat(2_100)}">Team</a>
        `, "Company");
      }
    });

    const result = await service.discoverPublicPeople(company.id);

    expect(requestedUrls).toEqual([HOME_URL]);
    expect(result.warnings).toContainEqual({
      code: "invalid-data",
      sourceUrl: HOME_URL,
      message: "Official people candidate URL exceeds 2048 characters or 4096 UTF-8 bytes"
    });
  });
});
