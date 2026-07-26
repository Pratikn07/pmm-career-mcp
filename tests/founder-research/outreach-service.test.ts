import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  LINKEDIN_CONNECTION_NOTE_MAX_CODE_POINTS,
  createFounderOutreachService,
  type SaveFounderOutreachBatchInput
} from "../../src/founder-research/outreach-service.js";
import {
  createTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHECKED_AT = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();

let db: TestCareerDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.resetForTests();
});

afterAll(async () => {
  await db?.close();
});

async function addRunPerson(options: {
  ownerSubject?: string;
  identityStatus?: "VERIFIED" | "CONFIRMED" | "CANDIDATE";
  canonicalProfile?: boolean;
  name?: string;
} = {}) {
  const ownerSubject = options.ownerSubject ?? OWNER;
  const identityStatus = options.identityStatus ?? "VERIFIED";
  const company = await db.companies.upsert({
    ycId: `yc-${randomUUID()}`,
    name: "Evidence Labs",
    checkedAt: CHECKED_AT
  });
  const person = await db.people.upsert({
    companyId: company.id,
    name: options.name ?? "Ada Lovelace",
    role: "Co-Founder",
    checkedAt: CHECKED_AT
  });
  const evidence = await db.evidence.add({
    personId: person.id,
    sourceUrl: `https://evidence.example/${person.id}`,
    title: "Product launch",
    factType: "public_role",
    fact: "Ada Lovelace led the Atlas launch at Evidence Labs.",
    checkedAt: CHECKED_AT,
    confidence: 0.95
  });
  const { run, items } = await db.founderResearchRuns.create({
    ownerSubject,
    queryJson: { source: "test" },
    requestedLimit: 1,
    companyIds: [company.id]
  });
  const runPerson = await db.founderResearchPeople.saveOfficial({
    runItemId: items[0]!.id,
    ownerSubject,
    personId: person.id,
    founderRoleMatch: "Co-Founder",
    confidence: 0.95
  });

  if (identityStatus === "CANDIDATE") {
    const candidate = await db.founderProfileCandidates.saveCandidate({
      runPersonId: runPerson.id,
      ownerSubject,
      profileUrl: "https://www.linkedin.com/in/ada-lovelace",
      searchQuery: "Ada Lovelace Evidence Labs founder LinkedIn",
      evidenceUrl: "https://www.linkedin.com/in/ada-lovelace?trk=public_profile",
      evidenceTitle: "Ada Lovelace - Co-Founder at Evidence Labs",
      evidenceSnippet: "Ada Lovelace is the co-founder of Evidence Labs.",
      evidenceMetadataJson: { linkedInNotFetched: true },
      checkedAt: CHECKED_AT,
      confidence: 0.8
    });
    if (options.canonicalProfile === true) {
      await db.founderProfileCandidates.confirm({
        candidateId: candidate.id,
        ownerSubject,
        decidedAt: CHECKED_AT
      });
    }
  } else if (options.canonicalProfile !== false) {
    const canonical = await db.founderProfileCandidates.recordOfficial({
      runPersonId: runPerson.id,
      ownerSubject,
      profileUrl: "https://www.linkedin.com/in/ada-lovelace",
      evidenceUrl: "https://evidence.example/official-profile",
      evidenceTitle: "Leadership",
      evidenceSnippet: "Ada Lovelace, Co-Founder",
      evidenceMetadataJson: { source: "official" },
      checkedAt: CHECKED_AT,
      confidence: 0.95,
      sourceKind: "OFFICIAL_COMPANY"
    });
    if (identityStatus === "CONFIRMED") {
      await db.founderProfileCandidates.confirm({
        candidateId: canonical.id,
        ownerSubject,
        decidedAt: CHECKED_AT
      });
    }
  }

  return { company, person, evidence, run, runPerson, ownerSubject };
}

async function addVerifiedRunForPerson(
  context: Awaited<ReturnType<typeof addRunPerson>>
) {
  const { run, items } = await db.founderResearchRuns.create({
    ownerSubject: context.ownerSubject,
    queryJson: { source: "second-test-run" },
    requestedLimit: 1,
    companyIds: [context.company.id]
  });
  const runPerson = await db.founderResearchPeople.saveOfficial({
    runItemId: items[0]!.id,
    ownerSubject: context.ownerSubject,
    personId: context.person.id,
    founderRoleMatch: "Co-Founder",
    confidence: 0.95
  });
  await db.founderProfileCandidates.recordOfficial({
    runPersonId: runPerson.id,
    ownerSubject: context.ownerSubject,
    profileUrl: "https://www.linkedin.com/in/ada-lovelace",
    evidenceUrl: "https://evidence.example/second-official-profile",
    evidenceTitle: "Leadership",
    evidenceSnippet: "Ada Lovelace, Co-Founder",
    evidenceMetadataJson: { source: "official" },
    checkedAt: CHECKED_AT,
    confidence: 0.95,
    sourceKind: "OFFICIAL_COMPANY"
  });
  return { run, runPerson };
}

function entryFor(
  context: Awaited<ReturnType<typeof addRunPerson>>,
  overrides: Partial<SaveFounderOutreachBatchInput["entries"][number]> = {}
) {
  return {
    personId: context.person.id,
    pmmOpportunity: 30,
    referralPotential: 25,
    networkValue: 20,
    total: 75,
    confidence: 0.9,
    reasons: ["Founder role is verified"],
    missingEvidence: [],
    evidenceIds: [context.evidence.id],
    personalizationClaims: [{
      text: "Atlas launch at Evidence Labs",
      evidenceIds: [context.evidence.id]
    }],
    text: "Hi Ada Lovelace — I appreciated Atlas launch at Evidence Labs. I’d value connecting.",
    ...overrides
  };
}

function service(subject = OWNER) {
  return createFounderOutreachService(db, { subject });
}

async function expectDomainError(
  action: () => Promise<unknown>,
  code: DomainError["code"]
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

describe("founder outreach batches", () => {
  it("saves only verified or confirmed people as ready draft targets", async () => {
    const verified = await addRunPerson();
    const confirmed = await addRunPerson({ identityStatus: "CONFIRMED" });
    const candidate = await addRunPerson({ identityStatus: "CANDIDATE" });
    const result = await service().saveBatch({
      runId: verified.run.id,
      requestId: "ready-and-candidate",
      entries: [entryFor(verified)]
    });
    const confirmedResult = await service().saveBatch({
      runId: confirmed.run.id,
      requestId: "confirmed",
      entries: [entryFor(confirmed)]
    });
    const candidateResult = await service().saveBatch({
      runId: candidate.run.id,
      requestId: "candidate",
      entries: [entryFor(candidate)]
    });

    expect(result.drafts).toEqual([expect.objectContaining({
      personId: verified.person.id,
      version: 1,
      purpose: "linkedin_connection_request"
    })]);
    expect(confirmedResult.drafts).toHaveLength(1);
    expect(candidateResult.drafts).toEqual([]);
    expect(candidateResult.needsVerification).toEqual([{
      personId: candidate.person.id,
      reason: "PROFILE_NOT_CONFIRMED"
    }]);
    expect(await db.targets.getByPerson(candidate.person.id)).toBeUndefined();
  });

  it("normalizes NFC and enforces the 200 Unicode code-point connection-note limit", async () => {
    const context = await addRunPerson();
    const decomposed = "Cafe\u0301";
    const caféEvidence = await db.evidence.add({
      personId: context.person.id,
      sourceUrl: "https://evidence.example/cafe",
      factType: "public_role",
      fact: "Café",
      checkedAt: CHECKED_AT,
      confidence: 0.95
    });
    const prefix = "Hi Ada Lovelace — I appreciated ";
    const suffix = ". I’d value connecting.";
    const emojiClaim = "🙂".repeat(
      LINKEDIN_CONNECTION_NOTE_MAX_CODE_POINTS - Array.from(prefix + suffix).length
    );
    const emojiEvidence = await db.evidence.add({
      personId: context.person.id,
      sourceUrl: "https://evidence.example/emoji",
      factType: "public_role",
      fact: emojiClaim,
      checkedAt: CHECKED_AT,
      confidence: 0.95
    });
    const atLimit = `${prefix}${emojiClaim}${suffix}`;
    const saved = await service().saveBatch({
      runId: context.run.id,
      requestId: "unicode-at-limit",
      entries: [entryFor(context, {
        text: atLimit,
        evidenceIds: [emojiEvidence.id],
        personalizationClaims: [{ text: emojiClaim, evidenceIds: [emojiEvidence.id] }]
      })]
    });
    const normalized = await service().saveBatch({
      runId: context.run.id,
      requestId: "unicode-normalization",
      entries: [entryFor(context, {
        text: `Hi Ada Lovelace — I appreciated ${decomposed}. I’d value connecting.`,
        evidenceIds: [caféEvidence.id],
        personalizationClaims: [{ text: "Café", evidenceIds: [caféEvidence.id] }]
      })]
    });

    expect(saved.drafts[0]?.text).toBe(atLimit);
    expect(normalized.drafts[0]?.text).toBe(
      "Hi Ada Lovelace — I appreciated Café. I’d value connecting."
    );
    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "unicode-over-limit",
        entries: [entryFor(context, {
          text: "🙂".repeat(LINKEDIN_CONNECTION_NOTE_MAX_CODE_POINTS + 1),
          evidenceIds: [],
          personalizationClaims: []
        })]
      }),
      "VALIDATION_ERROR"
    );
  });

  it("requires exact selected-person evidence for each factual personalization claim", async () => {
    const selected = await addRunPerson();
    const other = await addRunPerson({ name: "Grace Hopper" });
    const mismatched = await expectDomainError(
      () => service().saveBatch({
        runId: selected.run.id,
        requestId: "wrong-evidence",
        entries: [entryFor(selected, { evidenceIds: [other.evidence.id] })]
      }),
      "EVIDENCE_MISMATCH"
    );
    expect(mismatched.details).toEqual({ field: "entries[0].evidenceIds" });
    await expectDomainError(
      () => service().saveBatch({
        runId: selected.run.id,
        requestId: "unsupported-claim",
        entries: [entryFor(selected, {
          personalizationClaims: [{
            text: "Ada Lovelace raised a Series B.",
            evidenceIds: [selected.evidence.id]
          }]
        })]
      }),
      "EVIDENCE_MISMATCH"
    );
  });

  it("allows a generic safe note with no personalization claims or evidence", async () => {
    const context = await addRunPerson();
    const result = await service().saveBatch({
      runId: context.run.id,
      requestId: "generic-note",
      entries: [entryFor(context, {
        text: "Hi Ada Lovelace — I work in product marketing and would value connecting.",
        evidenceIds: [],
        personalizationClaims: []
      })]
    });

    expect(result.drafts).toEqual([expect.objectContaining({ evidenceIds: [] })]);
  });

  it("rejects factual personalized note text that has no supported claim", async () => {
    const context = await addRunPerson();

    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "unclaimed-series-b",
        entries: [entryFor(context, {
          text: "Congrats on your Series B — I’d value connecting.",
          evidenceIds: [],
          personalizationClaims: []
        })]
      }),
      "EVIDENCE_MISMATCH"
    );
    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "unclaimed-great-product",
        entries: [entryFor(context, {
          text: "Hi Ada Lovelace — great product; I’d love to connect.",
          evidenceIds: [],
          personalizationClaims: []
        })]
      }),
      "EVIDENCE_MISMATCH"
    );
    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "unclaimed-impressive-work",
        entries: [entryFor(context, {
          text: "Hi Ada Lovelace — impressive work; I’d love to connect.",
          evidenceIds: [],
          personalizationClaims: []
        })]
      }),
      "EVIDENCE_MISMATCH"
    );
    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "unclaimed-keynote",
        entries: [entryFor(context, {
          text: "I enjoyed your keynote at SaaStr and would value connecting.",
          evidenceIds: [],
          personalizationClaims: []
        })]
      }),
      "EVIDENCE_MISMATCH"
    );
    expect(await db.targets.getByPerson(context.person.id)).toBeUndefined();
  });

  it("requires each claim to occur wholly in one cited evidence title or fact", async () => {
    const context = await addRunPerson();
    const secondEvidence = await db.evidence.add({
      personId: context.person.id,
      sourceUrl: "https://evidence.example/funding",
      title: "secured Series B",
      factType: "public_role",
      fact: "Funding update",
      checkedAt: CHECKED_AT,
      confidence: 0.95
    });

    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "claim-spans-evidence-records",
        entries: [entryFor(context, {
          text: "Congrats on Evidence Labs. secured Series B.",
          evidenceIds: [context.evidence.id, secondEvidence.id],
          personalizationClaims: [{
            text: "Evidence Labs. secured Series B",
            evidenceIds: [context.evidence.id, secondEvidence.id]
          }]
        })]
      }),
      "EVIDENCE_MISMATCH"
    );
  });

  it("does not match a claim across one evidence title and fact", async () => {
    const context = await addRunPerson();

    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "claim-spans-title-and-fact",
        entries: [entryFor(context, {
          text: "I appreciated Product launch Ada Lovelace.",
          personalizationClaims: [{
            text: "Product launch Ada Lovelace",
            evidenceIds: [context.evidence.id]
          }]
        })]
      }),
      "EVIDENCE_MISMATCH"
    );
  });

  it("creates one immutable connection-request version per target and is idempotent per request", async () => {
    const context = await addRunPerson();
    const input = {
      runId: context.run.id,
      requestId: "same-batch-request",
      entries: [entryFor(context)]
    };
    const outreach = service();
    const first = await outreach.saveBatch(input);
    const second = await outreach.saveBatch(structuredClone(input));
    const targetUpsertSpy = vi.spyOn(db.targets, "upsert");
    const retriedAfterRestart = await service().saveBatch(structuredClone(input));
    const target = await db.targets.getByPerson(context.person.id);

    expect(second).toEqual(first);
    expect(retriedAfterRestart).toEqual(first);
    expect(targetUpsertSpy).not.toHaveBeenCalled();
    expect(first.drafts[0]).toMatchObject({ version: 1 });
    expect(await db.outreachDrafts.listForTarget(target!.id)).toHaveLength(1);
  });

  it("creates the next immutable version for a genuinely changed batch request", async () => {
    const context = await addRunPerson();
    const first = await service().saveBatch({
      runId: context.run.id,
      requestId: "original-note",
      entries: [entryFor(context)]
    });
    const changed = await service().saveBatch({
      runId: context.run.id,
      requestId: "changed-note",
      entries: [entryFor(context, {
        text: "Hi Ada Lovelace — I’m interested in Atlas launch at Evidence Labs and would value connecting."
      })]
    });

    expect(first.drafts[0]).toMatchObject({ version: 1 });
    expect(changed.drafts[0]).toMatchObject({ version: 2 });
  });

  it("coalesces simultaneous identical batch requests into one immutable version", async () => {
    const context = await addRunPerson();
    const input = {
      runId: context.run.id,
      requestId: "concurrent-batch-request",
      entries: [entryFor(context)]
    };
    const firstService = service();
    const secondService = service();

    const [first, second] = await Promise.all([
      firstService.saveBatch(input),
      secondService.saveBatch(structuredClone(input))
    ]);
    const target = await db.targets.getByPerson(context.person.id);

    expect(second).toEqual(first);
    expect(first.drafts[0]).toMatchObject({ version: 1 });
    expect(await db.outreachDrafts.listForTarget(target!.id)).toHaveLength(1);
  });

  it("atomically arbitrates conflicting first requests before either target score can be overwritten", async () => {
    const context = await addRunPerson();
    const firstEntry = entryFor(context);
    const secondEntry = entryFor(context, {
      pmmOpportunity: 31,
      total: 76,
      reasons: ["Competing score"]
    });
    const requests = [firstEntry, secondEntry].map((entry) => service().saveBatch({
      runId: context.run.id,
      requestId: "concurrent-conflicting-first-request",
      entries: [entry]
    }));
    const outcomes = await Promise.allSettled(requests);
    const fulfilled = outcomes.flatMap((outcome, index) => (
      outcome.status === "fulfilled" ? [{ index, value: outcome.value }] : []
    ));
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "CONFLICT" });
    const target = await db.targets.getByPerson(context.person.id);
    const winner = [firstEntry, secondEntry][fulfilled[0]!.index]!;
    const targetId = fulfilled[0]!.value.drafts[0]!.targetId;

    expect(await db.outreachDrafts.listForTarget(targetId)).toHaveLength(1);
    expect(target).toMatchObject({
      pmmOpportunity: winner.pmmOpportunity,
      referralPotential: winner.referralPotential,
      networkValue: winner.networkValue,
      totalScore: winner.total,
      confidence: winner.confidence,
      rationale: JSON.stringify({
        version: 1,
        reasons: winner.reasons,
        missingEvidence: winner.missingEvidence
      })
    });
  });

  it("durably reuses request A after request B and rejects a changed request-A payload", async () => {
    const context = await addRunPerson();
    const requestA = {
      runId: context.run.id,
      requestId: "request-a",
      entries: [entryFor(context)]
    };
    const first = await service().saveBatch(requestA);
    const second = await service().saveBatch({
      runId: context.run.id,
      requestId: "request-b",
      entries: [entryFor(context, {
        text: "Hi Ada Lovelace — I’m interested in Atlas launch at Evidence Labs and would value connecting."
      })]
    });
    const retriedA = await service().saveBatch(structuredClone(requestA));

    expect(first.drafts[0]).toMatchObject({ version: 1 });
    expect(second.drafts[0]).toMatchObject({ version: 2 });
    expect(retriedA).toEqual(first);
    await expectDomainError(
      () => service().saveBatch({
        ...requestA,
        entries: [entryFor(context, {
          text: "Hi Ada Lovelace — I’m interested in Atlas launch at Evidence Labs and would value connecting."
        })]
      }),
      "CONFLICT"
    );
  });

  it.each([
    {
      label: "target score",
      change: async (context: Awaited<ReturnType<typeof addRunPerson>>) => entryFor(context, {
        pmmOpportunity: 31,
        total: 76
      })
    },
    {
      label: "reasons",
      change: async (context: Awaited<ReturnType<typeof addRunPerson>>) => entryFor(context, {
        reasons: ["A different verified reason"]
      })
    },
    {
      label: "missing evidence",
      change: async (context: Awaited<ReturnType<typeof addRunPerson>>) => entryFor(context, {
        missingEvidence: ["Recent funding evidence"]
      })
    },
    {
      label: "personalization claims",
      change: async (context: Awaited<ReturnType<typeof addRunPerson>>) => entryFor(context, {
        personalizationClaims: [{
          text: "Atlas launch",
          evidenceIds: [context.evidence.id]
        }]
      })
    },
    {
      label: "evidence ordering and content",
      change: async (context: Awaited<ReturnType<typeof addRunPerson>>) => {
        const extra = await db.evidence.add({
          personId: context.person.id,
          sourceUrl: "https://evidence.example/extra",
          fact: "Extra evidence",
          checkedAt: CHECKED_AT,
          confidence: 0.95
        });
        return entryFor(context, {
          evidenceIds: [extra.id, context.evidence.id]
        });
      }
    },
    {
      label: "review state",
      change: async (context: Awaited<ReturnType<typeof addRunPerson>>) => entryFor(context, {
        reviewState: "NEEDS_REVIEW" as never
      })
    },
    {
      label: "note text",
      change: async (context: Awaited<ReturnType<typeof addRunPerson>>) => entryFor(context, {
        text: "Hi Ada Lovelace — I’m interested in Atlas launch at Evidence Labs and would value connecting."
      })
    }
  ])("rejects a changed $label payload without mutating the original target or draft", async ({ change }) => {
    const context = await addRunPerson();
    const request = {
      runId: context.run.id,
      requestId: "full-payload-request",
      entries: [entryFor(context)]
    };
    const original = await service().saveBatch(request);
    const target = await db.targets.get(original.drafts[0]!.targetId);
    const drafts = await db.outreachDrafts.listForTarget(original.drafts[0]!.targetId);

    await expectDomainError(
      async () => service().saveBatch({ ...request, entries: [await change(context)] }),
      "CONFLICT"
    );

    expect(await db.targets.get(original.drafts[0]!.targetId)).toEqual(target);
    expect(await db.outreachDrafts.listForTarget(original.drafts[0]!.targetId)).toEqual(drafts);
  });

  it("canonicalizes evidence and claim ID ordering for an identical retry", async () => {
    const context = await addRunPerson();
    const additionalEvidence = await db.evidence.add({
      personId: context.person.id,
      sourceUrl: "https://evidence.example/ordering",
      fact: "Atlas launch received customer praise.",
      checkedAt: CHECKED_AT,
      confidence: 0.95
    });
    const request = {
      runId: context.run.id,
      requestId: "canonical-evidence-order",
      entries: [entryFor(context, {
        evidenceIds: [context.evidence.id, additionalEvidence.id],
        personalizationClaims: [{
          text: "Atlas launch at Evidence Labs",
          evidenceIds: [context.evidence.id, additionalEvidence.id]
        }]
      })]
    };
    const first = await service().saveBatch(request);
    const reordered = await service().saveBatch({
      ...request,
      entries: [entryFor(context, {
        evidenceIds: [additionalEvidence.id, context.evidence.id],
        personalizationClaims: [{
          text: "Atlas launch at Evidence Labs",
          evidenceIds: [additionalEvidence.id, context.evidence.id]
        }]
      })]
    });

    expect(reordered).toEqual(first);
    expect(await db.outreachDrafts.listForTarget(first.drafts[0]!.targetId)).toHaveLength(1);
  });

  it("rejects a same request ID from a changed run before mutating its saved target or draft", async () => {
    const context = await addRunPerson();
    const first = await service().saveBatch({
      runId: context.run.id,
      requestId: "run-is-part-of-payload",
      entries: [entryFor(context)]
    });
    const target = await db.targets.get(first.drafts[0]!.targetId);
    const drafts = await db.outreachDrafts.listForTarget(first.drafts[0]!.targetId);
    const secondRun = await addVerifiedRunForPerson(context);

    await expectDomainError(
      () => service().saveBatch({
        runId: secondRun.run.id,
        requestId: "run-is-part-of-payload",
        entries: [entryFor(context)]
      }),
      "CONFLICT"
    );

    expect(await db.targets.get(first.drafts[0]!.targetId)).toEqual(target);
    expect(await db.outreachDrafts.listForTarget(first.drafts[0]!.targetId)).toEqual(drafts);
  });

  it("uses the authenticated owner and rejects missing or foreign run people", async () => {
    const context = await addRunPerson();
    await expectDomainError(
      () => service(OTHER_OWNER).saveBatch({
        runId: context.run.id,
        requestId: "foreign-owner",
        entries: [entryFor(context)]
      }),
      "NOT_FOUND"
    );
    await expectDomainError(
      () => service().saveBatch({
        runId: randomUUID(),
        requestId: "missing-run",
        entries: [entryFor(context)]
      }),
      "NOT_FOUND"
    );
    await expectDomainError(
      () => service().saveBatch({
        runId: context.run.id,
        requestId: "missing-person",
        entries: [entryFor(context, { personId: randomUUID() })]
      }),
      "NOT_FOUND"
    );
  });

  it("only saves drafts and never sends or connects through LinkedIn", async () => {
    const context = await addRunPerson();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await service().saveBatch({
      runId: context.run.id,
      requestId: "draft-only",
      entries: [entryFor(context)]
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("sent");
    expect(result).not.toHaveProperty("connected");
  });
});
