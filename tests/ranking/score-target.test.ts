import { describe, expect, it } from "vitest";
import {
  explainTargetMatch,
  rankTargetScores,
  scoreTarget,
  type ScoreTargetInput
} from "../../src/ranking/score-target.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");

function fixture(checkedAt: string): ScoreTargetInput {
  return {
    companyName: "Example Labs",
    person: {
      id: "person-1",
      companyId: "company-1",
      name: "Ada Lovelace",
      role: "VP Product Marketing",
      checkedAt,
      confidence: 0.9,
      evidence: [{
        id: "evidence-1",
        url: "https://example.com/team",
        sourceUrl: "https://example.com/team",
        title: "Team",
        fact: "Ada Lovelace is VP Product Marketing",
        checkedAt,
        confidence: 0.9
      }]
    },
    opportunities: [{
      id: "opportunity-1",
      companyId: "company-1",
      title: "Product Marketing Manager",
      location: "San Francisco",
      sourceUrl: "https://example.com/careers/pmm",
      checkedAt,
      active: true
    }],
    preferences: {
      roleKeywords: ["product marketing"],
      preferredLocations: ["San Francisco"],
      industries: ["developer tools"]
    },
    weights: {
      pmmOpportunity: 3,
      referralPotential: 2,
      networkValue: 1
    },
    evidence: {
      activePmmRole: true,
      companyHiring: true,
      roleSeniority: true,
      sharedDomain: true,
      locationMatch: true,
      recentFundingSignal: true,
      companyCheckedAt: checkedAt
    }
  };
}

describe("scoreTarget", () => {
  it("exposes weighted components and lowers confidence for stale evidence", () => {
    const fresh = scoreTarget(fixture("2026-07-15T00:00:00.000Z"), NOW);
    const stale = scoreTarget(fixture("2025-01-01T00:00:00.000Z"), NOW);

    expect(fresh.total).toBe(
      fresh.pmmOpportunity + fresh.referralPotential + fresh.networkValue
    );
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.missingEvidence).toContain("fresh company evidence");
  });

  it.each([
    ["NaN", { pmmOpportunity: Number.NaN, referralPotential: 1, networkValue: 1 }, [0, 50, 50]],
    ["Infinity", { pmmOpportunity: Number.POSITIVE_INFINITY, referralPotential: 1, networkValue: 1 }, [0, 50, 50]],
    ["negative", { pmmOpportunity: -4, referralPotential: 1, networkValue: 1 }, [0, 50, 50]],
    ["all zero", { pmmOpportunity: 0, referralPotential: 0, networkValue: 0 }, [100 / 3, 100 / 3, 100 / 3]],
    ["large finite", {
      pmmOpportunity: Number.MAX_VALUE,
      referralPotential: Number.MAX_VALUE,
      networkValue: Number.MAX_VALUE
    }, [100 / 3, 100 / 3, 100 / 3]]
  ] as const)("normalizes weights with a safe default for %s input", (_label, weights, expected) => {
    const score = scoreTarget({ ...fixture("2026-07-15T00:00:00.000Z"), weights }, NOW);

    expect(score.pmmOpportunity).toBeCloseTo(expected[0], 10);
    expect(score.referralPotential).toBeCloseTo(expected[1], 10);
    expect(score.networkValue).toBeCloseTo(expected[2], 10);
    expect(score.total).toBe(
      score.pmmOpportunity + score.referralPotential + score.networkValue
    );
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it("normalizes ordinary configurable weights to one", () => {
    const score = scoreTarget(fixture("2026-07-15T00:00:00.000Z"), NOW);

    expect(score.pmmOpportunity).toBe(50);
    expect(score.referralPotential).toBeCloseTo(100 / 3, 10);
    expect(score.networkValue).toBeCloseTo(100 / 6, 10);
    expect(score.total).toBe(100);
  });

  it("explains only positive typed evidence and names absent or false evidence", () => {
    const input = fixture("2026-07-15T00:00:00.000Z");
    input.evidence = {
      activePmmRole: true,
      companyHiring: false,
      sharedDomain: true,
      locationMatch: false,
      recentFundingSignal: false,
      companyCheckedAt: "2026-07-15T00:00:00.000Z"
    };

    const score = scoreTarget(input, NOW);

    expect(score.reasons).toEqual([
      "Has a verified active PMM role",
      "Works in a shared target domain"
    ]);
    expect(score.missingEvidence).toEqual([
      "company hiring evidence",
      "role seniority",
      "location match",
      "recent funding signal"
    ]);
    expect(score.reasons.join(" ")).not.toMatch(/hiring|seniority|location|funding/i);
  });

  it("returns defensive explanation arrays", () => {
    const score = scoreTarget(fixture("2026-07-15T00:00:00.000Z"), NOW);
    const explanation = explainTargetMatch(score);

    expect(explanation).toEqual({
      reasons: score.reasons,
      missingEvidence: score.missingEvidence
    });
    explanation.reasons.push("invented");
    explanation.missingEvidence.push("invented");
    expect(score.reasons).not.toContain("invented");
    expect(score.missingEvidence).not.toContain("invented");
  });

  it("bases confidence on evidence presence and freshness, not match desirability", () => {
    const richInput = fixture("2026-07-15T00:00:00.000Z");
    const lowDesirabilityInput = fixture("2026-07-15T00:00:00.000Z");
    lowDesirabilityInput.evidence = {
      activePmmRole: false,
      companyHiring: false,
      roleSeniority: false,
      sharedDomain: false,
      locationMatch: false,
      recentFundingSignal: false,
      companyCheckedAt: "2026-07-15T00:00:00.000Z"
    };
    const sparseInput = fixture("2026-07-15T00:00:00.000Z");
    sparseInput.person.evidence = [];
    sparseInput.opportunities = [];

    const rich = scoreTarget(richInput, NOW);
    const lowDesirability = scoreTarget(lowDesirabilityInput, NOW);
    const sparse = scoreTarget(sparseInput, NOW);

    expect(lowDesirability.total).toBe(0);
    expect(lowDesirability.confidence).toBe(rich.confidence);
    expect(sparse.confidence).toBeLessThan(rich.confidence);
    expect(sparse.missingEvidence).toEqual(expect.arrayContaining([
      "person source evidence",
      "opportunity evidence"
    ]));
    expect(rich.confidence).toBeGreaterThanOrEqual(0);
    expect(rich.confidence).toBeLessThanOrEqual(1);
  });

  it.each([
    ["exactly 30 days old", "2026-06-16T12:00:00.000Z", true],
    ["30 days and 1 ms old", "2026-06-16T11:59:59.999Z", false],
    ["exactly 5 minutes ahead", "2026-07-16T12:05:00.000Z", true],
    ["5 minutes and 1 ms ahead", "2026-07-16T12:05:00.001Z", false]
  ] as const)("defines company evidence freshness at %s", (_label, checkedAt, validAndFresh) => {
    const score = scoreTarget(fixture(checkedAt), NOW);

    if (validAndFresh) {
      expect(score.missingEvidence).not.toContain("fresh company evidence");
      expect(score.missingEvidence).not.toContain("valid company evidence timestamp");
    } else {
      expect(score.missingEvidence).toContain("fresh company evidence");
    }
    if (checkedAt > "2026-07-16T12:05:00.000Z") {
      expect(score.missingEvidence).toContain("valid company evidence timestamp");
    }
  });

  it("deduplicates evidence and opportunities when computing confidence", () => {
    const single = fixture("2026-07-15T00:00:00.000Z");
    const duplicated = fixture("2026-07-15T00:00:00.000Z");
    duplicated.person.evidence = [
      ...duplicated.person.evidence,
      ...duplicated.person.evidence.map((item) => ({ ...item }))
    ];
    duplicated.opportunities = [
      ...duplicated.opportunities,
      ...duplicated.opportunities.map((item) => ({ ...item }))
    ];

    expect(scoreTarget(duplicated, NOW)).toEqual(scoreTarget(single, NOW));
  });

  it("is invariant to collection order and does not mutate its input", () => {
    const input = fixture("2026-07-15T00:00:00.000Z");
    const tinyEvidence = Array.from({ length: 100 }, (_, index) => ({
      ...input.person.evidence[0]!,
      id: `tiny-${index}`,
      confidence: 1e-17
    }));
    input.person.evidence = [input.person.evidence[0]!, ...tinyEvidence];
    input.opportunities = [
      ...input.opportunities,
      {
        ...input.opportunities[0]!,
        id: "opportunity-2",
        title: "Senior Product Marketing Manager"
      }
    ];
    input.preferences = {
      roleKeywords: ["marketing", "product"],
      preferredLocations: ["Remote", "San Francisco"],
      industries: ["AI", "developer tools"]
    };
    const reversed: ScoreTargetInput = {
      ...structuredClone(input),
      person: {
        ...structuredClone(input.person),
        evidence: [...input.person.evidence].reverse()
      },
      opportunities: [...input.opportunities].reverse(),
      preferences: {
        roleKeywords: [...input.preferences.roleKeywords].reverse(),
        preferredLocations: [...input.preferences.preferredLocations].reverse(),
        industries: [...input.preferences.industries].reverse()
      }
    };
    const before = structuredClone(input);

    expect(scoreTarget(reversed, NOW)).toEqual(scoreTarget(input, NOW));
    expect(input).toEqual(before);
  });

  it("keeps every generated score finite and within its public bounds", () => {
    let state = 0x1234_5678;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let index = 0; index < 256; index += 1) {
      const input = fixture("2026-07-15T00:00:00.000Z");
      input.weights = {
        pmmOpportunity: (next() % 10_000) - 2_000,
        referralPotential: (next() % 10_000) - 2_000,
        networkValue: (next() % 10_000) - 2_000
      };
      input.evidence = {
        activePmmRole: (next() & 1) === 1,
        companyHiring: (next() & 1) === 1,
        roleSeniority: (next() & 1) === 1,
        sharedDomain: (next() & 1) === 1,
        locationMatch: (next() & 1) === 1,
        recentFundingSignal: (next() & 1) === 1,
        companyCheckedAt: "2026-07-15T00:00:00.000Z"
      };

      const score = scoreTarget(input, NOW);
      for (const value of [
        score.pmmOpportunity,
        score.referralPotential,
        score.networkValue,
        score.total
      ]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
      expect(score.total).toBe(
        score.pmmOpportunity + score.referralPotential + score.networkValue
      );
      expect(score.confidence).toBeGreaterThanOrEqual(0);
      expect(score.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("ranks total-score ties by company, name, and person id independent of permutation", () => {
    const createScore = (
      personId: string,
      companyName: string,
      name: string
    ) => {
      const input = fixture("2026-07-15T00:00:00.000Z");
      input.companyName = companyName;
      input.person = { ...input.person, id: personId, name };
      return scoreTarget(input, NOW);
    };
    const scores = [
      createScore("person-z", "Zeta", "Ada"),
      createScore("person-b", "Alpha", "Bea"),
      createScore("person-a", "Alpha", "Bea"),
      createScore("person-c", "Alpha", "Cy")
    ];
    const before = [...scores];
    const expected = ["person-a", "person-b", "person-c", "person-z"];

    expect(rankTargetScores(scores).map((score) => score.personId)).toEqual(expected);
    expect(rankTargetScores([...scores].reverse()).map((score) => score.personId)).toEqual(expected);
    expect(scores).toEqual(before);
  });
});
