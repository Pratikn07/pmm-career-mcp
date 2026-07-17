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
const CHECKED_AT = "2026-07-16T12:00:00.000Z";
const YC_DIRECTORY_URL = "https://www.ycombinator.com/companies";

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
    expect(requestedUrls).toEqual([YC_DIRECTORY_URL]);
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
