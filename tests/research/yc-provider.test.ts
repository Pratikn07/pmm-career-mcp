import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SourceChangedError,
  createPublicYcSource,
  createYcProvider,
  type YcSource
} from "../../src/research/yc-provider.js";

const fixturePath = fileURLToPath(new URL("../fixtures/yc-company.html", import.meta.url));
const currentListFixturePath = fileURLToPath(
  new URL("../fixtures/yc-company-list-current.html", import.meta.url)
);
const CHECKED_AT = "2026-07-16T12:00:00.000Z";
const YC_DIRECTORY_URL = "https://www.ycombinator.com/companies";
const YC_DEFAULT_FACET_URL = "https://www.ycombinator.com/companies/industry/marketing";

async function fixtureSource(overrides: Partial<Awaited<ReturnType<YcSource["fetch"]>>> = {}) {
  return {
    fetch: async () => ({
      html: await readFile(fixturePath, "utf8"),
      url: YC_DIRECTORY_URL,
      checkedAt: CHECKED_AT,
      ...overrides
    })
  } satisfies YcSource;
}

describe("YC company provider", () => {
  it("parses and normalizes public company HTML into deterministic source-backed records", async () => {
    const provider = createYcProvider(await fixtureSource());

    const results = await provider.search({});

    expect(results.map((item) => item.name)).toEqual([
      "Acme AI",
      "Beacon Robotics",
      "Orbit Health"
    ]);
    expect(results[0]).toMatchObject({
      id: "acme-ai",
      ycId: "acme-ai",
      name: "Acme AI",
      batch: "W24",
      status: "Active",
      location: "San Francisco, California",
      industry: "B2B / AI",
      hiring: true,
      websiteUrl: "https://acme.example/",
      checkedAt: CHECKED_AT
    });
    expect(results[0]?.sources[0]).toMatchObject({
      url: "https://www.ycombinator.com/companies/acme-ai",
      sourceUrl: "https://www.ycombinator.com/companies/acme-ai",
      checkedAt: CHECKED_AT
    });
    expect(results[1]?.sources[0]?.url).toBe(
      "https://www.ycombinator.com/companies/beacon-robotics"
    );
    expect(results[2]?.websiteUrl).toBe(
      "https://www.ycombinator.com/companies/orbit-health/website"
    );
  });

  it("loads the public YC HTML directory through the safe page-fetch seam", async () => {
    const requestedUrls: string[] = [];
    const html = await readFile(fixturePath, "utf8");
    const source = createPublicYcSource(async (url) => {
      requestedUrls.push(url);
      return {
        url,
        title: "Companies | Y Combinator",
        text: "YC companies",
        html,
        checkedAt: CHECKED_AT,
        contentType: "text/html",
        untrusted: true
      };
    });

    const results = await createYcProvider(source).search({ keyword: "robotics" });

    expect(results.map((item) => item.name)).toEqual(["Beacon Robotics"]);
    expect(requestedUrls).toEqual([YC_DEFAULT_FACET_URL]);
  });

  it("parses the current server-rendered YC company-list cards", async () => {
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      })
    } satisfies YcSource;

    const results = await createYcProvider(source).search({ industry: "recruiting" });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      ycId: "drippay",
      name: "Drip",
      batch: "P2026",
      status: "Active",
      location: "San Francisco",
      industry: "messaging / recruiting / b2b",
      description: "Never miss a lead."
    });
    expect(results[1]).toMatchObject({
      ycId: "litmus-hiring",
      name: "Litmus",
      batch: "S2026",
      status: "Active",
      location: "New York City",
      industry: "talent-acquisition / recruiting"
    });
  });

  it("parses current YC cards after the safety fetcher resolves company links", async () => {
    const html = (await readFile(currentListFixturePath, "utf8")).replaceAll(
      'href="/companies/',
      'href="https://www.ycombinator.com/companies/'
    );
    const source = {
      fetch: async () => ({
        html,
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      })
    } satisfies YcSource;

    const results = await createYcProvider(source).search({ industry: "recruiting" });

    expect(results.map((company) => company.ycId)).toEqual(["drippay", "litmus-hiring"]);
  });

  it("keeps a current YC card while omitting an oversized SEO description", async () => {
    const html = (await readFile(currentListFixturePath, "utf8")).replace(
      "Never miss a lead.",
      "D".repeat(501)
    );
    const source = {
      fetch: async () => ({
        html,
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      })
    } satisfies YcSource;

    const results = await createYcProvider(source).search({ industry: "recruiting" });
    const drip = results.find((company) => company.ycId === "drippay");

    expect(drip).toMatchObject({ name: "Drip" });
    expect(drip).not.toHaveProperty("description");
    expect(drip?.warnings).toContainEqual({
      code: "invalid-data",
      sourceUrl: "https://www.ycombinator.com/companies/industry/recruiting",
      message: "Omitted an oversized YC company description"
    });
  });

  it("selects official server-rendered YC facet pages from the search query", async () => {
    const requestedUrls: string[] = [];
    const html = await readFile(currentListFixturePath, "utf8");
    const source = createPublicYcSource(async (url) => {
      requestedUrls.push(url);
      return {
        url,
        title: "YC companies",
        text: "YC companies",
        html,
        checkedAt: CHECKED_AT,
        contentType: "text/html",
        untrusted: true
      };
    });
    const provider = createYcProvider(source);

    await provider.search({ industry: "Recruiting" });
    await provider.search({ location: "San Francisco", hiring: true });
    await provider.search({ keyword: "lead" });

    expect(requestedUrls).toEqual([
      "https://www.ycombinator.com/companies/industry/recruiting",
      "https://www.ycombinator.com/companies/location/san-francisco-bay-area/hiring",
      "https://www.ycombinator.com/companies/industry/marketing"
    ]);
  });

  it("rejects a production YC source redirected to an off-origin page", async () => {
    const html = await readFile(fixturePath, "utf8");
    const source = createPublicYcSource(async () => ({
      url: "https://attacker.example/directory",
      title: "Fake YC directory",
      text: "Fake companies",
      html,
      checkedAt: CHECKED_AT,
      contentType: "text/html",
      untrusted: true
    }));

    await expect(createYcProvider(source).search({})).rejects.toThrow(/final.*origin/i);
  });

  it("rejects a production YC source redirected to a non-directory YC path", async () => {
    const html = await readFile(fixturePath, "utf8");
    const source = createPublicYcSource(async () => ({
      url: "https://www.ycombinator.com/companies/acme-ai",
      title: "Acme AI",
      text: "Company page",
      html,
      checkedAt: CHECKED_AT,
      contentType: "text/html",
      untrusted: true
    }));

    await expect(createYcProvider(source).search({})).rejects.toThrow(/final.*pathname/i);
  });

  it.each([
    [{ batch: "w24" }, ["Acme AI", "Orbit Health"]],
    [{ keyword: "AI" }, ["Acme AI"]],
    [{ location: "san francisco" }, ["Acme AI"]],
    [{ status: "active" }, ["Acme AI", "Beacon Robotics"]],
    [{ hiring: false }, ["Beacon Robotics"]],
    [{ industry: "health" }, ["Orbit Health"]],
    [{ batch: "W24", keyword: "AI", hiring: true }, ["Acme AI"]]
  ] as const)("filters deterministically for %j", async (query, expectedNames) => {
    const provider = createYcProvider(await fixtureSource());

    const results = await provider.search(query);

    expect(results.map((item) => item.name)).toEqual(expectedNames);
  });

  it("fails loudly when the recognizable YC directory layout changes", async () => {
    const provider = createYcProvider(await fixtureSource({
      html: "<html><body><main><p>No recognizable company cards</p></main></body></html>"
    }));

    await expect(provider.search({})).rejects.toBeInstanceOf(SourceChangedError);
    await expect(provider.search({})).rejects.toThrow(/YC.*layout.*changed/i);
  });

  it("rejects invalid source freshness instead of returning misleading records", async () => {
    const provider = createYcProvider(await fixtureSource({ checkedAt: "yesterday" }));

    await expect(provider.search({})).rejects.toThrow(/checkedAt.*ISO/i);
  });

  it("rejects future-dated YC source evidence beyond the allowed clock skew", async () => {
    const provider = createYcProvider(await fixtureSource({
      checkedAt: "2026-07-16T12:06:00.000Z"
    }), {
      now: () => new Date("2026-07-16T12:00:00.000Z")
    });

    await expect(provider.search({})).rejects.toThrow(/5-minute future-skew/i);
  });

  it("retains stale YC results with an explicit 30-day policy warning", async () => {
    const provider = createYcProvider(await fixtureSource({
      checkedAt: "2026-05-01T00:00:00.000Z"
    }), {
      now: () => new Date("2026-07-16T12:00:00.000Z")
    });

    const results = await provider.search({ keyword: "Acme" });

    expect(results[0]?.warnings).toEqual([{
      code: "stale-source",
      sourceUrl: YC_DIRECTORY_URL,
      message: "YC source is older than the 30-day freshness policy"
    }]);
  });

  it("fails loudly when every recognizable YC card is invalid", async () => {
    const provider = createYcProvider(await fixtureSource({
      html: `
        <title>Y Combinator Companies</title>
        <main data-yc-company-directory>
          <article data-yc-company-id="invalid-company">
            <a class="company-name" href="/companies/invalid-company">${"N".repeat(161)}</a>
          </article>
        </main>
      `
    }));

    await expect(provider.search({})).rejects.toBeInstanceOf(SourceChangedError);
    await expect(provider.search({})).rejects.toThrow(
      /YC directory contains 1 invalid recognizable company card/i
    );
  });

  it("fails loudly when a recognizable YC directory mixes valid and invalid cards", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    const html = fixture.replace(">Acme AI</a>", `>${"N".repeat(161)}</a>`);
    const provider = createYcProvider(await fixtureSource({ html }));

    await expect(provider.search({})).rejects.toBeInstanceOf(SourceChangedError);
    await expect(provider.search({})).rejects.toThrow(
      /YC directory contains 1 invalid recognizable company card/i
    );
  });

  it("returns a legitimate filtered zero when every recognizable YC card is valid", async () => {
    const provider = createYcProvider(await fixtureSource());

    const results = await provider.search({ keyword: "no-company-matches-this" });

    expect(results).toEqual([]);
  });
});
