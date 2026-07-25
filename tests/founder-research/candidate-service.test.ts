import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  CANDIDATE_FIELD_LIMITS,
  createFounderCandidateService,
  type SaveFounderProfileCandidateInput
} from "../../src/founder-research/candidate-service.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

const NOW = "2026-07-25T18:00:00.000Z";
const CHECKED_AT = "2026-07-25T17:55:00.000Z";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

type Context = Awaited<ReturnType<typeof addCandidateContext>>;

async function addCandidateContext(options: {
  ownerSubject?: string;
  companyName?: string;
  personName?: string;
  personRole?: string;
  savedFounderEvidence?: boolean;
} = {}) {
  const ownerSubject = options.ownerSubject ?? OWNER;
  const companyName = options.companyName ?? "Candidate Labs";
  const company = await db.companies.upsert({
    ycId: `yc-${randomUUID()}`,
    name: companyName,
    ycUrl: `https://www.ycombinator.com/companies/${randomUUID()}`,
    websiteUrl: "https://candidate.example",
    checkedAt: CHECKED_AT
  });
  const person = await db.people.upsert({
    companyId: company.id,
    name: options.personName ?? "Ada Lovelace",
    role: options.personRole ?? "Co-Founder",
    checkedAt: CHECKED_AT
  });
  if (options.savedFounderEvidence === true) {
    await db.evidence.add({
      personId: person.id,
      sourceUrl: `https://www.ycombinator.com/companies/${companyName.toLowerCase()}`,
      title: `${companyName} founders`,
      factType: "public_role",
      fact: "Founder",
      checkedAt: CHECKED_AT,
      confidence: 1
    });
  }
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
    founderRoleMatch: "co-founder",
    confidence: 0.9
  });
  return {
    company,
    item: items[0]!,
    ownerSubject,
    person,
    run,
    runPerson
  };
}

function candidateInput(
  context: Context,
  overrides: Partial<SaveFounderProfileCandidateInput> = {}
): SaveFounderProfileCandidateInput {
  return {
    runId: context.run.id,
    runItemId: context.item.id,
    runPersonId: context.runPerson.id,
    founderName: context.person.name,
    founderRole: context.person.role,
    candidateProfileUrl: "https://www.linkedin.com/in/ada-lovelace",
    searchQuery: `${context.person.name} ${context.company.name} founder LinkedIn`,
    resultUrl: "https://www.linkedin.com/in/ada-lovelace?trk=public_profile",
    resultTitle: `${context.person.name} - ${context.person.role} at ${context.company.name}`,
    resultSnippet: `${context.person.name} is the co-founder of ${context.company.name}.`,
    checkedAt: CHECKED_AT,
    confidence: 0.78,
    linkedInNotFetched: true,
    ...overrides
  };
}

function service(
  ownerSubject = OWNER,
  now = NOW
) {
  return createFounderCandidateService(db, {
    subject: ownerSubject,
    now: () => new Date(now)
  });
}

async function expectDomainError(
  action: () => Promise<unknown>,
  code: string
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

describe("Founder candidate service", () => {
  it("saves exact public-search evidence under the authenticated owner without fetching LinkedIn", async () => {
    const context = await addCandidateContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await service().saveCandidate(candidateInput(context));

    expect(result.candidate).toMatchObject({
      ownerSubject: OWNER,
      runPersonId: context.runPerson.id,
      profileUrl: "https://www.linkedin.com/in/ada-lovelace",
      status: "CANDIDATE",
      sourceKind: "PUBLIC_SEARCH",
      searchQuery: "Ada Lovelace Candidate Labs founder LinkedIn",
      evidenceUrl: "https://www.linkedin.com/in/ada-lovelace?trk=public_profile",
      evidenceTitle: "Ada Lovelace - Co-Founder at Candidate Labs",
      evidenceSnippet: "Ada Lovelace is the co-founder of Candidate Labs.",
      checkedAt: CHECKED_AT,
      confidence: 0.78
    });
    expect(result.canonical).toBeUndefined();
    expect(result.requiresManualReview).toBe(true);
    expect(result.candidate.evidenceMetadataJson).toMatchObject({
      linkedInNotFetched: true,
      submittedFounderName: "Ada Lovelace",
      submittedFounderRole: "Co-Founder",
      companyId: context.company.id,
      personId: context.person.id
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is idempotent when the same candidate and evidence are submitted twice", async () => {
    const context = await addCandidateContext();
    const first = await service().saveCandidate(candidateInput(context));
    const second = await service().saveCandidate(candidateInput(context));

    expect(second.candidate.id).toBe(first.candidate.id);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.founder_profile_candidates
      where owner_subject = '${OWNER}'
    `)).toEqual([{ count: 1 }]);
  });

  it.each([
    ["malformed", "July 24, 2026", "VALIDATION_ERROR"],
    ["stale", "2026-06-25T17:59:59.999Z", "EVIDENCE_MISMATCH"],
    ["too far in the future", "2026-07-25T18:05:00.001Z", "VALIDATION_ERROR"]
  ])("rejects %s public-search timestamps", async (_label, checkedAt, code) => {
    const context = await addCandidateContext();
    await expectDomainError(
      () => service().saveCandidate(candidateInput(context, { checkedAt })),
      code
    );
  });

  it("accepts evidence at the exact 30-day freshness and five-minute future boundaries", async () => {
    const firstContext = await addCandidateContext({ companyName: "Fresh Boundary" });
    await expect(service().saveCandidate(candidateInput(firstContext, {
      checkedAt: "2026-06-25T18:00:00.000Z"
    }))).resolves.toMatchObject({ requiresManualReview: true });

    const secondContext = await addCandidateContext({ companyName: "Future Boundary" });
    await expect(service().saveCandidate(candidateInput(secondContext, {
      candidateProfileUrl: "https://www.linkedin.com/in/future-boundary",
      resultUrl: "https://linkedin.com/in/future-boundary",
      checkedAt: "2026-07-25T18:05:00.000Z"
    }))).resolves.toMatchObject({ requiresManualReview: true });
  });

  it("requires the candidate and public-search result URLs to canonicalize identically", async () => {
    const context = await addCandidateContext();
    const error = await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        resultUrl: "https://www.linkedin.com/in/grace-hopper"
      })),
      "EVIDENCE_MISMATCH"
    );

    expect(error.message).toBe("Public-search evidence does not match the candidate");
    expect(error.details).toMatchObject({
      field: "resultUrl",
      reason: "candidate_url_mismatch"
    });
  });

  it.each([
    ["blank search query", { searchQuery: "   " }],
    [
      "missing title and snippet",
      { resultTitle: undefined, resultSnippet: undefined }
    ],
    ["missing non-fetch attestation", { linkedInNotFetched: false }],
    ["invalid confidence", { confidence: Number.NaN }]
  ] as const)("rejects malformed evidence with %s", async (_label, overrides) => {
    const context = await addCandidateContext();
    await expectDomainError(
      () => service().saveCandidate({
        ...candidateInput(context),
        ...overrides
      } as SaveFounderProfileCandidateInput),
      "VALIDATION_ERROR"
    );
  });

  it("rejects malformed LinkedIn URLs and never opens them", async () => {
    const context = await addCandidateContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        candidateProfileUrl: "https://linkedin.com.evil.example/in/ada-lovelace",
        resultUrl: "https://linkedin.com.evil.example/in/ada-lovelace"
      })),
      "VALIDATION_ERROR"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "founderName",
      (context: Context) => candidateInput(context, {
        founderName: "😀".repeat(CANDIDATE_FIELD_LIMITS.founderName.characters)
      })
    ],
    [
      "searchQuery",
      (context: Context) => candidateInput(context, {
        searchQuery: "q".repeat(CANDIDATE_FIELD_LIMITS.searchQuery.characters + 1)
      })
    ],
    [
      "founderRole",
      (context: Context) => candidateInput(context, {
        founderRole: `Founder ${"😀".repeat(
          CANDIDATE_FIELD_LIMITS.founderRole.characters
        )}`
      })
    ],
    [
      "resultTitle",
      (context: Context) => candidateInput(context, {
        resultTitle: "😀".repeat(CANDIDATE_FIELD_LIMITS.resultTitle.characters)
      })
    ],
    [
      "resultSnippet",
      (context: Context) => candidateInput(context, {
        resultSnippet: "😀".repeat(CANDIDATE_FIELD_LIMITS.resultSnippet.characters)
      })
    ]
  ] as const)("enforces code-point and UTF-8 byte bounds for %s", async (field, makeInput) => {
    const context = await addCandidateContext();
    const error = await expectDomainError(
      () => service().saveCandidate(makeInput(context)),
      "VALIDATION_ERROR"
    );
    expect(error.details.field).toBe(field);
  });

  it("does not expose rejected raw input in safe errors", async () => {
    const context = await addCandidateContext();
    const sentinel = `DO-NOT-ECHO-${randomUUID()}`;
    const error = await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        searchQuery: sentinel.repeat(100)
      })),
      "VALIDATION_ERROR"
    );
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(sentinel);
  });

  it("denies wrong-owner and mismatched run references without disclosing which reference exists", async () => {
    const context = await addCandidateContext();
    const wrongOwner = await expectDomainError(
      () => service(OTHER_OWNER).saveCandidate(candidateInput(context)),
      "NOT_FOUND"
    );
    const wrongRunItem = await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        runItemId: randomUUID()
      })),
      "NOT_FOUND"
    );

    expect(wrongOwner.message).toBe("Founder research person was not found");
    expect(wrongRunItem.message).toBe(wrongOwner.message);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.founder_profile_candidates
    `)).toEqual([{ count: 0 }]);
  });

  it("denies a wrong-owner decision without adding an audit event", async () => {
    const context = await addCandidateContext();
    const saved = await service().saveCandidate(candidateInput(context));

    await expectDomainError(
      () => service(OTHER_OWNER).decideCandidate({
        candidateId: saved.candidate.id,
        decision: "CONFIRM"
      }),
      "NOT_FOUND"
    );
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.founder_profile_confirmation_events
    `)).toEqual([{ count: 0 }]);
  });

  it("retains multiple candidates as ambiguous manual-review records and never chooses one canonically", async () => {
    const context = await addCandidateContext();
    const first = await service().saveCandidate(candidateInput(context));
    const second = await service().saveCandidate(candidateInput(context, {
      candidateProfileUrl: "https://www.linkedin.com/in/ada-lovelace-pmm",
      resultUrl: "https://www.linkedin.com/in/ada-lovelace-pmm",
      resultTitle: "Ada Lovelace - Founder",
      confidence: 0.72
    }));

    expect(first.requiresManualReview).toBe(true);
    expect(second.requiresManualReview).toBe(true);
    expect(second.canonical).toBeUndefined();
    expect(await queryTestDatabase<{ status: string; profile_url: string }>(db, `
      select status, profile_url
      from career_mcp.founder_profile_candidates
      where run_person_id = '${context.runPerson.id}'
      order by profile_url
    `)).toEqual([
      {
        profile_url: "https://www.linkedin.com/in/ada-lovelace",
        status: "CANDIDATE"
      },
      {
        profile_url: "https://www.linkedin.com/in/ada-lovelace-pmm",
        status: "CANDIDATE"
      }
    ]);
  });

  it("does not replace a VERIFIED canonical profile when saving a public-search candidate", async () => {
    const context = await addCandidateContext();
    const verified = await db.founderProfileCandidates.recordOfficial({
      runPersonId: context.runPerson.id,
      ownerSubject: OWNER,
      profileUrl: "https://www.linkedin.com/in/ada-official",
      sourceKind: "OFFICIAL_COMPANY",
      evidenceUrl: "https://candidate.example/team",
      evidenceTitle: "Team",
      evidenceSnippet: "Ada Lovelace, Co-Founder",
      evidenceMetadataJson: { card: 1 },
      checkedAt: CHECKED_AT,
      confidence: 0.99
    });

    const saved = await service().saveCandidate(candidateInput(context));

    expect(saved.candidate.status).toBe("CANDIDATE");
    expect(saved.canonical?.id).toBe(verified.id);
    expect(saved.requiresManualReview).toBe(true);
  });

  it("records a manual confirmation with authenticated actor, bounded note, and trusted server time", async () => {
    const context = await addCandidateContext();
    const saved = await service().saveCandidate(candidateInput(context));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const decisionWithUntrustedAuthorityFields = {
      candidateId: saved.candidate.id,
      decision: "CONFIRM",
      note: "I inspected the company and profile identity.",
      ownerSubject: OTHER_OWNER,
      decidedAt: "2000-01-01T00:00:00.000Z"
    } as const;
    const decided = await service().decideCandidate(
      decisionWithUntrustedAuthorityFields
    );

    expect(decided.candidate.status).toBe("CONFIRMED");
    expect(decided.canonical?.id).toBe(saved.candidate.id);
    expect(decided.requiresManualReview).toBe(false);
    expect(await db.people.get(context.person.id)).toMatchObject({
      publicProfileUrl: "https://www.linkedin.com/in/ada-lovelace"
    });
    const [event] = await queryTestDatabase<{
      owner_subject: string;
      event: string;
      note: string;
      created_at: string;
    }>(db, `
      select owner_subject, event, note, created_at::text
      from career_mcp.founder_profile_confirmation_events
      where candidate_id = '${saved.candidate.id}'
    `);
    expect(event).toMatchObject({
      owner_subject: OWNER,
      event: "CONFIRMED",
      note: "I inspected the company and profile identity."
    });
    expect(new Date(event!.created_at).toISOString()).toBe(NOW);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records rejection without creating a canonical profile", async () => {
    const context = await addCandidateContext();
    const saved = await service().saveCandidate(candidateInput(context));

    const decided = await service().decideCandidate({
      candidateId: saved.candidate.id,
      decision: "REJECT",
      note: "Different company."
    });

    expect(decided.candidate.status).toBe("REJECTED");
    expect(decided.canonical).toBeUndefined();
    expect(decided.requiresManualReview).toBe(false);
    expect((await db.people.get(context.person.id))?.publicProfileUrl).toBeNull();
  });

  it.each([
    ["CONFIRM", "CONFIRMED"],
    ["REJECT", "REJECTED"]
  ] as const)("makes a repeated %s decision idempotent with one audit event", async (
    decision,
    expectedStatus
  ) => {
    const context = await addCandidateContext();
    const saved = await service().saveCandidate(candidateInput(context));
    const first = await service().decideCandidate({
      candidateId: saved.candidate.id,
      decision,
      note: "Reviewed once."
    });
    const second = await service().decideCandidate({
      candidateId: saved.candidate.id,
      decision,
      note: "This second note must not create another event."
    });

    expect(first.candidate.status).toBe(expectedStatus);
    expect(second.candidate.status).toBe(expectedStatus);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.founder_profile_confirmation_events
      where candidate_id = '${saved.candidate.id}'
    `)).toEqual([{ count: 1 }]);
  });

  it("rejects conflicting final decisions as stale", async () => {
    const context = await addCandidateContext();
    const saved = await service().saveCandidate(candidateInput(context));
    await service().decideCandidate({
      candidateId: saved.candidate.id,
      decision: "REJECT"
    });

    const error = await expectDomainError(
      () => service().decideCandidate({
        candidateId: saved.candidate.id,
        decision: "CONFIRM"
      }),
      "INVALID_TRANSITION"
    );
    expect(error.message).toBe("Founder profile decision is stale");
  });

  it("accepts plain CEO only from current persisted identity plus saved explicit founder evidence", async () => {
    const trusted = await addCandidateContext({
      companyName: "Trusted Context",
      personRole: "CEO",
      savedFounderEvidence: true
    });
    await expect(service().saveCandidate(candidateInput(trusted, {
      founderRole: "CEO"
    }))).resolves.toMatchObject({ requiresManualReview: true });

    const untrusted = await addCandidateContext({
      companyName: "Untrusted Context",
      personRole: "CEO",
      savedFounderEvidence: false
    });
    const forged = {
      ...candidateInput(untrusted, {
        candidateProfileUrl: "https://www.linkedin.com/in/untrusted-ceo",
        resultUrl: "https://www.linkedin.com/in/untrusted-ceo",
        founderRole: "CEO"
      }),
      savedEvidence: {
        explicitFounder: true,
        assertedPersonFullName: untrusted.person.name
      }
    };
    await expectDomainError(
      () => service().saveCandidate(forged),
      "EVIDENCE_MISMATCH"
    );
  });

  it("requires the submitted founder name and role to match current persisted context", async () => {
    const context = await addCandidateContext();
    await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        founderName: "Grace Hopper"
      })),
      "EVIDENCE_MISMATCH"
    );
    await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        founderRole: "Investor"
      })),
      "EVIDENCE_MISMATCH"
    );
  });

  it("requires saved public-search evidence to contain current company context", async () => {
    const context = await addCandidateContext();
    const error = await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        searchQuery: "Ada Lovelace Other Company founder LinkedIn",
        resultTitle: "Ada Lovelace - Founder at Other Company",
        resultSnippet: "Ada Lovelace founded Other Company."
      })),
      "EVIDENCE_MISMATCH"
    );
    expect(error.details).toMatchObject({
      field: "searchQuery",
      reason: "company_context_mismatch"
    });
  });

  it("does not mistake a short company name for a substring in another word", async () => {
    const context = await addCandidateContext({ companyName: "AI" });
    await expectDomainError(
      () => service().saveCandidate(candidateInput(context, {
        searchQuery: "Ada Lovelace chair founder LinkedIn",
        resultTitle: "Ada Lovelace - Founder",
        resultSnippet: "A chair company founder."
      })),
      "EVIDENCE_MISMATCH"
    );
  });

  it("matches harmless founder-role capitalization against persisted context", async () => {
    const context = await addCandidateContext();
    await expect(service().saveCandidate(candidateInput(context, {
      founderRole: "co-founder"
    }))).resolves.toMatchObject({ requiresManualReview: true });
  });

  it("validates decision notes by code points and bytes without accepting a model timestamp or owner", async () => {
    const context = await addCandidateContext();
    const saved = await service().saveCandidate(candidateInput(context));
    const invalid = {
      candidateId: saved.candidate.id,
      decision: "CONFIRM",
      note: "😀".repeat(CANDIDATE_FIELD_LIMITS.decisionNote.characters),
      ownerSubject: OTHER_OWNER,
      decidedAt: "2000-01-01T00:00:00.000Z"
    } as const;

    const error = await expectDomainError(
      () => service().decideCandidate(invalid),
      "VALIDATION_ERROR"
    );
    expect(error.details.field).toBe("note");
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.founder_profile_confirmation_events
    `)).toEqual([{ count: 0 }]);
  });
});
