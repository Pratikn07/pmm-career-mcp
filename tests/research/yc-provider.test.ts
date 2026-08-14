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
const currentDetailFixturePath = fileURLToPath(
  new URL("../fixtures/yc-company-detail-current.html", import.meta.url)
);
const CHECKED_AT = "2026-07-16T12:00:00.000Z";
const YC_DIRECTORY_URL = "https://www.ycombinator.com/companies";
const YC_DEFAULT_FACET_URL = "https://www.ycombinator.com/companies/industry/marketing";

function currentCompanyListFixture(count: number): string {
  const cards = Array.from({ length: count }, (_unused, index) => {
    const suffix = String(index).padStart(2, "0");
    return `
      <li class="company-result">
        <a href="/companies/company-${suffix}">
          <span class="text-2xl">Company ${suffix}</span>
          <span>P2026</span>
          <span class="text-gray-700">Active</span>
        </a>
      </li>
    `;
  }).join("");
  return `<html><head><title>YC companies</title></head><body><main><ul>${cards}</ul></main></body></html>`;
}

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

  it("hydrates only filtered current-list results from their YC detail pages", async () => {
    const fetchedDetails: string[] = [];
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async (url: string) => {
        fetchedDetails.push(url);
        return {
          html: await readFile(currentDetailFixturePath, "utf8"),
          url,
          checkedAt: CHECKED_AT
        };
      }
    } satisfies YcSource;

    const results = await createYcProvider(source).search({ keyword: "Drip" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ycId: "drippay",
      websiteUrl: "https://example.com/"
    });
    expect(fetchedDetails).toEqual(["https://www.ycombinator.com/companies/drippay"]);
  });

  it("does not use a LinkedIn link as a company website", async () => {
    const detailHtml = (await readFile(currentDetailFixturePath, "utf8")).replace(
      /\s*<a aria-label="Company website"[^>]*>.*?<\/a>/,
      ""
    );
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async (url: string) => ({ html: detailHtml, url, checkedAt: CHECKED_AT })
    } satisfies YcSource;

    const [result] = await createYcProvider(source).search({ keyword: "Drip" });

    expect(result?.websiteUrl ?? null).toBeNull();
  });

  it("keeps search results when one selected company detail page fails", async () => {
    const detailHtml = await readFile(currentDetailFixturePath, "utf8");
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async (url: string) => {
        if (url.endsWith("/drippay")) {
          throw new Error("detail unavailable");
        }
        return { html: detailHtml, url, checkedAt: CHECKED_AT };
      }
    } satisfies YcSource;

    const results = await createYcProvider(source).search({ industry: "recruiting" });

    expect(results.map((company) => company.name)).toEqual(["Drip", "Litmus"]);
    expect(results[0]?.websiteUrl ?? null).toBeNull();
    expect(results[1]?.websiteUrl).toBe("https://example.com/");
  });

  it("keeps search results when a selected company detail page times out", async () => {
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      }
    } satisfies YcSource;

    const results = await createYcProvider(source).search({ keyword: "Drip" });

    expect(results.map((company) => company.name)).toEqual(["Drip"]);
    expect(results[0]?.websiteUrl ?? null).toBeNull();
  });

  it.each([
    "javascript:alert('not a website')",
    "mailto:founders@example.com",
    "https://user:secret@example.com",
    "http://localhost/company",
    "http://service.localhost/company",
    "http://127.0.0.1/company",
    "http://[::1]/company",
    "https://linkedin.com/company/example-company",
    "https://www.linkedin.com/company/example-company",
    "https://careers.linkedin.com/company/example-company",
    "https://linkedin.com../company/example-company",
    "https://careers.linkedin.com../company/example-company"
  ])("ignores an invalid explicit company website URL: %s", async (websiteHref) => {
    const detailHtml = (await readFile(currentDetailFixturePath, "utf8")).replace(
      "https://example.com",
      websiteHref
    );
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async (url: string) => ({ html: detailHtml, url, checkedAt: CHECKED_AT })
    } satisfies YcSource;

    const [result] = await createYcProvider(source).search({ keyword: "Drip" });

    expect(result?.websiteUrl ?? null).toBeNull();
  });

  it("keeps list and detail provenance when their timestamps differ", async () => {
    const detailCheckedAt = "2026-07-16T12:01:00.000Z";
    const detailUrl = "https://www.ycombinator.com/companies/drippay";
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async () => ({
        html: await readFile(currentDetailFixturePath, "utf8"),
        url: detailUrl,
        checkedAt: detailCheckedAt
      })
    } satisfies YcSource;

    const [result] = await createYcProvider(source, {
      now: () => new Date("2026-07-16T13:00:00.000Z")
    }).search({ keyword: "Drip" });

    expect(result?.sources).toHaveLength(2);
    expect(result?.sources[0]).toMatchObject({
      sourceUrl: detailUrl,
      checkedAt: CHECKED_AT
    });
    expect(result?.sources[1]).toMatchObject({
      url: "https://example.com/",
      sourceUrl: detailUrl,
      checkedAt: detailCheckedAt,
      fact: expect.stringMatching(/website/i),
      confidence: 1
    });
  });

  it.each([
    ["malformed", "yesterday"],
    ["future-dated", "2026-07-16T12:06:00.000Z"]
  ])("fails %s detail timestamps as optional enrichment", async (_label, detailCheckedAt) => {
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async (url: string) => ({
        html: await readFile(currentDetailFixturePath, "utf8"),
        url,
        checkedAt: detailCheckedAt
      })
    } satisfies YcSource;

    const [result] = await createYcProvider(source, {
      now: () => new Date("2026-07-16T12:00:00.000Z")
    }).search({ keyword: "Drip" });

    expect(result?.websiteUrl ?? null).toBeNull();
    expect(result?.sources).toHaveLength(1);
  });

  it("retains stale detail provenance with an explicit stale-source warning", async () => {
    const detailUrl = "https://www.ycombinator.com/companies/drippay";
    const detailCheckedAt = "2026-05-01T00:00:00.000Z";
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async () => ({
        html: await readFile(currentDetailFixturePath, "utf8"),
        url: detailUrl,
        checkedAt: detailCheckedAt
      })
    } satisfies YcSource;

    const [result] = await createYcProvider(source, {
      now: () => new Date("2026-07-16T12:00:00.000Z")
    }).search({ keyword: "Drip" });

    expect(result?.websiteUrl).toBe("https://example.com/");
    expect(result?.sources[1]?.checkedAt).toBe(detailCheckedAt);
    expect(result?.warnings).toContainEqual({
      code: "stale-source",
      sourceUrl: detailUrl,
      message: "YC company detail source is older than the 30-day freshness policy"
    });
  });

  it("does not retain a website whose detail evidence exceeds field bounds", async () => {
    const detailHtml = (await readFile(currentDetailFixturePath, "utf8")).replace(
      "Example Company: Company | Y Combinator",
      "T".repeat(301)
    );
    const source = {
      fetch: async () => ({
        html: await readFile(currentListFixturePath, "utf8"),
        url: "https://www.ycombinator.com/companies/industry/recruiting",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async (url: string) => ({
        html: detailHtml,
        url,
        checkedAt: CHECKED_AT
      })
    } satisfies YcSource;

    const [result] = await createYcProvider(source).search({ keyword: "Drip" });

    expect(result?.websiteUrl ?? null).toBeNull();
    expect(result?.sources).toHaveLength(1);
  });

  it("caps detail hydration at 50 companies with at most four concurrent requests", async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const requestedUrls: string[] = [];
    const source = {
      fetch: async () => ({
        html: currentCompanyListFixture(55),
        url: "https://www.ycombinator.com/companies/industry/marketing",
        checkedAt: CHECKED_AT
      }),
      fetchCompanyDetail: async (url: string) => {
        requestedUrls.push(url);
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeRequests -= 1;
        return {
          html: await readFile(currentDetailFixturePath, "utf8"),
          url,
          checkedAt: CHECKED_AT
        };
      }
    } satisfies YcSource;

    const results = await createYcProvider(source).search({});

    expect(results).toHaveLength(55);
    expect(requestedUrls).toHaveLength(50);
    expect(requestedUrls[0]).toBe("https://www.ycombinator.com/companies/company-00");
    expect(requestedUrls.at(-1)).toBe("https://www.ycombinator.com/companies/company-49");
    expect(maximumActiveRequests).toBe(4);
    expect(results.filter((company) => company.websiteUrl !== undefined)).toHaveLength(50);
  });

  it("does not swallow a failed list fetch and retries it on the next search", async () => {
    let attempts = 0;
    const source = {
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("list unavailable");
        }
        return {
          html: await readFile(currentListFixturePath, "utf8"),
          url: "https://www.ycombinator.com/companies/industry/recruiting",
          checkedAt: CHECKED_AT
        };
      }
    } satisfies YcSource;
    const provider = createYcProvider(source);

    await expect(provider.search({ keyword: "Drip" })).rejects.toThrow("list unavailable");
    await expect(provider.search({ keyword: "Drip" })).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
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

    expect(requestedUrls.filter((url) => /\/companies\/(?:industry|location)\//.test(url))).toEqual([
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

  it("loads company details through the public source safe-fetch seam", async () => {
    const requestedUrls: string[] = [];
    const listHtml = await readFile(currentListFixturePath, "utf8");
    const detailHtml = await readFile(currentDetailFixturePath, "utf8");
    const source = createPublicYcSource(async (url) => {
      requestedUrls.push(url);
      return {
        url,
        title: "YC company page",
        text: "YC company",
        html: url.endsWith("/drippay") ? detailHtml : listHtml,
        checkedAt: CHECKED_AT,
        contentType: "text/html",
        untrusted: true
      };
    });

    const results = await createYcProvider(source).search({ keyword: "Drip" });

    expect(results[0]?.websiteUrl).toBe("https://example.com/");
    expect(requestedUrls).toEqual([
      YC_DEFAULT_FACET_URL,
      "https://www.ycombinator.com/companies/drippay"
    ]);
  });

  it("rejects a public company detail redirected off the approved YC origins", async () => {
    const source = createPublicYcSource(async () => ({
      url: "https://attacker.example/companies/drippay",
      title: "Fake YC company",
      text: "Fake company",
      html: await readFile(currentDetailFixturePath, "utf8"),
      checkedAt: CHECKED_AT,
      contentType: "text/html",
      untrusted: true
    }));

    await expect(
      source.fetchCompanyDetail?.("https://www.ycombinator.com/companies/drippay")
    ).rejects.toThrow(/detail.*final.*origin/i);
  });

  it.each([
    "https://attacker.example/companies/drippay",
    "https://www.ycombinator.com/companies/drippay/jobs",
    "https://www.ycombinator.com/companies/drippay?next=jobs",
    "https://user@www.ycombinator.com/companies/drippay"
  ])("rejects an invalid public company detail input before fetching: %s", async (detailUrl) => {
    const requestedUrls: string[] = [];
    const source = createPublicYcSource(async (url) => {
      requestedUrls.push(url);
      return {
        url,
        title: "YC company",
        text: "YC company",
        html: await readFile(currentDetailFixturePath, "utf8"),
        checkedAt: CHECKED_AT,
        contentType: "text/html",
        untrusted: true
      };
    });

    await expect(source.fetchCompanyDetail?.(detailUrl)).rejects.toThrow(/detail.*input/i);
    expect(requestedUrls).toEqual([]);
  });

  it("rejects a public company detail redirected to a nested YC path", async () => {
    const source = createPublicYcSource(async () => ({
      url: "https://www.ycombinator.com/companies/drippay/jobs",
      title: "YC jobs",
      text: "Jobs",
      html: await readFile(currentDetailFixturePath, "utf8"),
      checkedAt: CHECKED_AT,
      contentType: "text/html",
      untrusted: true
    }));

    await expect(
      source.fetchCompanyDetail?.("https://www.ycombinator.com/companies/drippay")
    ).rejects.toThrow(/detail.*final.*pathname/i);
  });

  it("rejects a public company detail redirected to another company", async () => {
    const source = createPublicYcSource(async () => ({
      url: "https://ycombinator.com/companies/litmus-hiring",
      title: "Litmus",
      text: "Litmus",
      html: await readFile(currentDetailFixturePath, "utf8"),
      checkedAt: CHECKED_AT,
      contentType: "text/html",
      untrusted: true
    }));

    await expect(
      source.fetchCompanyDetail?.("https://www.ycombinator.com/companies/drippay")
    ).rejects.toThrow(/detail.*same.*company/i);
  });

  it("allows public company detail canonicalization between approved YC origins", async () => {
    const source = createPublicYcSource(async () => ({
      url: "https://ycombinator.com/companies/drippay",
      title: "Drip",
      text: "Drip",
      html: await readFile(currentDetailFixturePath, "utf8"),
      checkedAt: CHECKED_AT,
      contentType: "text/html",
      untrusted: true
    }));

    await expect(
      source.fetchCompanyDetail?.("https://www.ycombinator.com/companies/drippay")
    ).resolves.toMatchObject({ url: "https://ycombinator.com/companies/drippay" });
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
