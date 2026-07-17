import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type TestCareerDatabase } from "../../src/db/client.js";
import type { FetchedPage } from "../../src/research/fetch-page.js";
import { createPeopleDiscovery } from "../../src/research/people-discovery.js";
import {
  DisabledSearchProvider,
  type SearchProvider
} from "../../src/research/search-provider.js";

const fixturePath = fileURLToPath(new URL("../fixtures/company-team.html", import.meta.url));
const CHECKED_AT = "2026-07-16T13:00:00.000Z";
const HOME_URL = "https://acme.example/";
const TEAM_URL = "https://acme.example/team";

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
  let database: TestCareerDatabase;

  beforeEach(() => {
    database = createDatabase(":memory:");
  });

  afterEach(() => database.close());

  it("discovers, normalizes, deduplicates, and persists people from official pages", async () => {
    const company = database.companies.upsert({
      ycId: "acme-ai",
      name: "Acme AI",
      websiteUrl: HOME_URL,
      checkedAt: "2026-07-15T00:00:00.000Z"
    });
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
    expect(database.people.listByCompany(company.id)).toHaveLength(4);
    expect(result.evidence).toHaveLength(4);
    expect(result.evidence.every(({ fact }) => fact.length < 100)).toBe(true);
    expect(result.evidence.map(({ fact }) => fact)).not.toContain(
      expect.stringContaining("large suite of workflow products")
    );
    for (const person of result.people) {
      const persisted = database.people.getWithEvidence(person.id);
      expect(persisted?.evidence).toHaveLength(1);
      expect(persisted?.evidence[0]?.fact).toBe(`${person.name} — ${person.role}`);
      expect(persisted?.evidence[0]?.fact).not.toContain("large suite of workflow products");
    }
  });

  it("returns successful official-page findings with a partial warning when another source fails", async () => {
    const company = database.companies.upsert({
      ycId: "partial-people",
      name: "Partial People",
      websiteUrl: HOME_URL
    });
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

  it("rejects discovery when the stored company has no official website", async () => {
    const company = database.companies.upsert({ ycId: "no-site", name: "No Site" });

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
    await expect(provider.search("site:acme.example team", 10)).resolves.toEqual([]);
  });

  it("starts with the official site and does not retain LinkedIn links from search-extended pages", async () => {
    const company = database.companies.upsert({
      ycId: "search-extended-people",
      name: "Search Extended People",
      websiteUrl: HOME_URL
    });
    const events: string[] = [];
    const searchProvider: SearchProvider = {
      coverage: "search-extended",
      search: async () => {
        events.push("search");
        return [{
          title: "Acme leadership interview",
          url: "https://press.example/acme-team",
          snippet: "Public interview"
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
});
