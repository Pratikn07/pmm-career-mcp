import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../support/database.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  PIPELINE_STATUSES,
  PIPELINE_TRANSITIONS,
  createPipelineService
} from "../../src/pipeline/service.js";
import type { TargetScore } from "../../src/ranking/score-target.js";

const db = await createTestDatabase();
const pipeline = createPipelineService(db);

afterEach(async () => (await db.resetForTests()));
afterAll(async () => (await db.close()));

async function addPerson(label: string, companyName = `Company ${label}`) {
  const company = (await db.companies.upsert({
    ycId: `yc-${label}`,
    name: companyName
  }));
  const person = (await db.people.upsert({
    companyId: company.id,
    name: `Person ${label}`,
    role: "VP Product Marketing"
  }));
  return { company, person };
}

async function scoreFor(
  label: string,
  companyName = `Company ${label}`
): Promise<TargetScore> {
  const { company, person } = (await addPerson(label, companyName));
  return {
    personId: person.id,
    companyId: company.id,
    companyName: company.name,
    name: person.name,
    pmmOpportunity: 30,
    referralPotential: 25,
    networkValue: 20,
    total: 75,
    confidence: 0.9,
    reasons: ["Has a verified active PMM role", "Company is actively hiring"],
    missingEvidence: ["recent funding signal"]
  };
}

async function expectDomainError(
  action: () => Promise<unknown>,
  code: string
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

type PersistenceFailureKind = "retryable" | "unknown";

const PRIVATE_PERSISTENCE_TEXT = "private-user-persistence-text";
const PRIVATE_DATABASE_URL = "postgresql://private-user:private-password@private.example/career";

function repositoryFailure(kind: PersistenceFailureKind): Error {
  const error = new Error(
    `${kind === "retryable" ? "serialization failed" : "database I/O failed"} at `
      + `${PRIVATE_DATABASE_URL}: ${PRIVATE_PERSISTENCE_TEXT}`
  );
  Object.assign(error, {
    code: kind === "retryable" ? "40001" : "XX000",
    sql: `INSERT INTO private_table VALUES ('${PRIVATE_PERSISTENCE_TEXT}')`,
    userText: PRIVATE_PERSISTENCE_TEXT
  });
  error.stack = `${error.message}\nSQL INSERT at ${PRIVATE_DATABASE_URL}`;
  return error;
}

function expectSanitizedPersistenceError(
  error: DomainError,
  kind: PersistenceFailureKind,
  entity: "target" | "note" | "shortlist"
): void {
  expect(error).toMatchObject({
    code: kind === "retryable" ? "CONFLICT" : "DATA_INTEGRITY",
    message: kind === "retryable"
      ? "Pipeline write could not be completed"
      : "Pipeline storage operation failed",
    details: { entity, retryable: kind === "retryable" }
  });
  expect("cause" in error).toBe(false);
  const exposed = [
    error.code,
    error.message,
    JSON.stringify(error.details),
    error.stack ?? ""
  ].join("\n");
  expect(exposed).not.toContain(PRIVATE_PERSISTENCE_TEXT);
  expect(exposed).not.toContain(PRIVATE_DATABASE_URL);
  expect(exposed).not.toContain("SQL INSERT");
  expect(exposed).not.toContain("40001");
  expect(exposed).not.toContain("XX000");
}

describe("pipeline statuses", () => {
  it("exports the complete fixed status enum and deterministic transition graph", () => {
    expect(PIPELINE_STATUSES).toEqual([
      "discovered",
      "shortlisted",
      "connect_planned",
      "connected",
      "contacted",
      "replied",
      "archived"
    ]);
    expect(PIPELINE_TRANSITIONS).toEqual({
      discovered: ["shortlisted", "archived"],
      shortlisted: ["connect_planned", "archived"],
      connect_planned: ["connected", "archived"],
      connected: ["contacted", "archived"],
      contacted: ["replied", "archived"],
      replied: ["archived"],
      archived: []
    });
  });

  it("allows every documented forward transition", async () => {
    const saved = (await pipeline.saveTarget((await scoreFor("transitions"))));

    for (const status of [
      "shortlisted",
      "connect_planned",
      "connected",
      "contacted",
      "replied",
      "archived"
    ] as const) {
      expect((await pipeline.updateStatus(saved.id, status)).status).toBe(status);
    }
  });

  it("rejects skips, reversals, and transitions out of archived with safe typed errors", async () => {
    const saved = (await pipeline.saveTarget((await scoreFor("invalid-transition"))));
    const skip = (await expectDomainError(
      async () => (await pipeline.updateStatus(saved.id, "connected")),
      "INVALID_TRANSITION"
    ));
    expect(skip.message).toBe("Pipeline status transition is not allowed");
    expect(skip.details).toEqual({ from: "discovered", to: "connected" });

    const archived = (await pipeline.updateStatus(saved.id, "archived"));
    (await expectDomainError(
      async () => (await pipeline.updateStatus(archived.id, "discovered")),
      "INVALID_TRANSITION"
    ));
  });

  it("rejects unknown statuses before persistence without reflecting input text", async () => {
    const saved = (await pipeline.saveTarget((await scoreFor("unknown-status"))));
    const secret = "private-status-secret";
    const error = (await expectDomainError(
      async () => (await pipeline.updateStatus(saved.id, secret as never)),
      "VALIDATION_ERROR"
    ));

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
    expect((await db.targets.get(saved.id))?.status).toBe("discovered");
  });

  it("treats same-status updates as idempotent no-ops", async () => {
    const saved = (await pipeline.saveTarget((await scoreFor("idempotent"))));
    const unchanged = (await pipeline.updateStatus(saved.id, "discovered"));

    expect(unchanged).toEqual(saved);
  });

  it("returns a typed not-found error for an unknown target", async () => {
    const error = (await expectDomainError(
      async () => (await pipeline.updateStatus("missing-target", "shortlisted")),
      "NOT_FOUND"
    ));

    expect(error).toMatchObject({
      message: "Target was not found",
      details: { entity: "target" }
    });
  });

  it("keeps exported status policy frozen and validation independent from runtime mutation", async () => {
    const original = [...PIPELINE_STATUSES];
    const mutableStatuses = PIPELINE_STATUSES as unknown as string[];
    let mutationThrew = false;
    let validationError: DomainError | undefined;

    try {
      try {
        mutableStatuses.push("private_runtime_status");
      } catch (error) {
        mutationThrew = error instanceof TypeError;
      }
      try {
        (await pipeline.listPipeline({ status: "private_runtime_status" as never }));
      } catch (error) {
        validationError = error as DomainError;
      }
    } finally {
      if (!Object.isFrozen(PIPELINE_STATUSES)) {
        mutableStatuses.splice(0, mutableStatuses.length, ...original);
      }
    }

    expect(Object.isFrozen(PIPELINE_STATUSES)).toBe(true);
    expect(mutationThrew).toBe(true);
    expect(PIPELINE_STATUSES).toEqual(original);
    expect(validationError).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("deep-freezes exported transitions and keeps authorization independent from mutation", async () => {
    const original = [...PIPELINE_TRANSITIONS.discovered];
    const mutableDiscovered = PIPELINE_TRANSITIONS.discovered as unknown as string[];
    let mutationThrew = false;
    let transitionError: DomainError | undefined;

    try {
      try {
        mutableDiscovered.push("connected");
      } catch (error) {
        mutationThrew = error instanceof TypeError;
      }
      const saved = (await pipeline.saveTarget((await scoreFor("runtime-transition-policy"))));
      try {
        (await pipeline.updateStatus(saved.id, "connected"));
      } catch (error) {
        transitionError = error as DomainError;
      }
    } finally {
      if (!Object.isFrozen(PIPELINE_TRANSITIONS.discovered)) {
        mutableDiscovered.splice(0, mutableDiscovered.length, ...original);
      }
    }

    expect(Object.isFrozen(PIPELINE_TRANSITIONS)).toBe(true);
    expect(Object.values(PIPELINE_TRANSITIONS).every(Object.isFrozen)).toBe(true);
    expect(mutationThrew).toBe(true);
    expect(PIPELINE_TRANSITIONS.discovered).toEqual(original);
    expect(transitionError).toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

describe("saved targets and pipeline listing", () => {
  it("persists score components, confidence, and defensive explanation arrays", async () => {
    const input = (await scoreFor("score"));
    const before = structuredClone(input);
    const saved = (await pipeline.saveTarget(input));

    expect(saved).toMatchObject({
      personId: input.personId,
      pmmOpportunity: input.pmmOpportunity,
      referralPotential: input.referralPotential,
      networkValue: input.networkValue,
      totalScore: input.total,
      confidence: input.confidence,
      status: "discovered",
      reasons: input.reasons,
      missingEvidence: input.missingEvidence
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(saved.createdAt).toISOString()).toBe(saved.createdAt);
    expect(new Date(saved.updatedAt).toISOString()).toBe(saved.updatedAt);
    expect(input).toEqual(before);

    input.reasons.push("Mutated after save");
    expect((await pipeline.listPipeline())[0]?.reasons).not.toContain("Mutated after save");
  });

  it("preserves current status when an existing target score is refreshed", async () => {
    const input = (await scoreFor("refresh"));
    const first = (await pipeline.saveTarget(input));
    (await pipeline.updateStatus(first.id, "shortlisted"));

    const refreshed = (await pipeline.saveTarget({
      ...input,
      pmmOpportunity: 35,
      total: 80,
      reasons: ["Updated evidence-backed reason"]
    }));

    expect(refreshed).toMatchObject({
      id: first.id,
      status: "shortlisted",
      pmmOpportunity: 35,
      totalScore: 80,
      reasons: ["Updated evidence-backed reason"]
    });
  });

  it("filters by company and status and returns a deterministic company/person order", async () => {
    const zeta = (await pipeline.saveTarget((await scoreFor("zeta", "Zeta"))));
    const alphaB = (await pipeline.saveTarget((await scoreFor("b", "Alpha"))));
    const alphaA = (await pipeline.saveTarget((await scoreFor("a", "Alpha"))));
    (await pipeline.updateStatus(alphaA.id, "shortlisted"));
    (await pipeline.updateStatus(alphaB.id, "shortlisted"));

    expect((await pipeline.listPipeline()).map((target) => target.id)).toEqual([
      alphaA.id,
      alphaB.id,
      zeta.id
    ]);
    expect((await pipeline.listPipeline({ status: "shortlisted" })).map((target) => target.id)).toEqual([
      alphaA.id,
      alphaB.id
    ]);
    expect((await pipeline.listPipeline({ companyId: await scoreCompanyId("zeta") }))).toEqual([zeta]);
  });

  async function scoreCompanyId(label: string): Promise<string> {
    return (await db.companies.getByYcId(`yc-${label}`))!.id;
  }

  it("validates filter lengths and status without exposing supplied filter text", async () => {
    const privateFilter = "x".repeat(257);
    const error = (await expectDomainError(
      async () => (await pipeline.listPipeline({ companyId: privateFilter })),
      "VALIDATION_ERROR"
    ));

    expect(error.message).not.toContain(privateFilter);
    expect(JSON.stringify(error.details)).not.toContain(privateFilter);
    (await expectDomainError(
      async () => (await pipeline.listPipeline({ status: "not-a-status" as never })),
      "VALIDATION_ERROR"
    ));
  });

  it("rejects a non-object filter with a typed validation error", async () => {
    (await expectDomainError(async () => (await pipeline.listPipeline(null as never)), "VALIDATION_ERROR"));
  });
});

describe("notes", () => {
  it("appends normalized notes in stable call order and returns saved timestamps", async () => {
    const target = (await pipeline.saveTarget((await scoreFor("notes"))));
    const first = (await pipeline.recordNote(target.id, "  Met at a PMM event  "));
    const second = (await pipeline.recordNote(target.id, "Follow up next week"));

    expect(first).toMatchObject({ text: "Met at a PMM event", updatedAt: first.createdAt });
    expect(second).toMatchObject({ text: "Follow up next week", updatedAt: second.createdAt });
    expect((await db.notes.listForTarget(target.id)).map((note) => note.text)).toEqual([
      "Met at a PMM event",
      "Follow up next week"
    ]);
  });

  it("rejects missing targets and empty or oversized note text safely", async () => {
    (await expectDomainError(async () => (await pipeline.recordNote("missing", "hello")), "NOT_FOUND"));
    const target = (await pipeline.saveTarget((await scoreFor("invalid-notes"))));
    (await expectDomainError(async () => (await pipeline.recordNote(target.id, "   ")), "VALIDATION_ERROR"));

    const privateText = "private".repeat(800);
    const error = (await expectDomainError(
      async () => (await pipeline.recordNote(target.id, privateText)),
      "VALIDATION_ERROR"
    ));
    expect(error.message).not.toContain(privateText);
    expect(JSON.stringify(error.details)).not.toContain(privateText);
  });
});

describe("shortlists", () => {
  it("validates and persists explicit positions in position order", async () => {
    const first = (await pipeline.saveTarget((await scoreFor("shortlist-1"))));
    const second = (await pipeline.saveTarget((await scoreFor("shortlist-2"))));
    const input = {
      name: "  Weekly shortlist  ",
      entries: [
        { targetId: first.id, position: 1 },
        { targetId: second.id, position: 0 }
      ]
    };
    const before = structuredClone(input);

    const shortlist = (await pipeline.createShortlist(input));

    expect(shortlist).toMatchObject({ name: "Weekly shortlist" });
    expect(shortlist.entries.map(({ targetId, position }) => ({ targetId, position }))).toEqual([
      { targetId: second.id, position: 0 },
      { targetId: first.id, position: 1 }
    ]);
    expect(input).toEqual(before);
  });

  it("supports ordered target IDs without mutating them", async () => {
    const first = (await pipeline.saveTarget((await scoreFor("ids-1"))));
    const second = (await pipeline.saveTarget((await scoreFor("ids-2"))));
    const targetIds = [second.id, first.id];

    const shortlist = (await pipeline.createShortlist({ name: "By IDs", targetIds }));

    expect(shortlist.entries.map((entry) => entry.targetId)).toEqual(targetIds);
    expect(targetIds).toEqual([second.id, first.id]);
  });

  it("rejects duplicate target IDs or positions before creating anything", async () => {
    const target = (await pipeline.saveTarget((await scoreFor("duplicates"))));

    (await expectDomainError(async () => (await pipeline.createShortlist({
      name: "Duplicate targets",
      targetIds: [target.id, target.id]
    })), "CONFLICT"));
    (await expectDomainError(async () => (await pipeline.createShortlist({
      name: "Duplicate positions",
      entries: [
        { targetId: target.id, position: 0 },
        { targetId: "other", position: 0 }
      ]
    })), "CONFLICT"));
    expect((await db.shortlists.list())).toEqual([]);
  });

  it("rejects gaps, negative positions, missing targets, and rolls back atomically", async () => {
    const target = (await pipeline.saveTarget((await scoreFor("rollback"))));
    (await expectDomainError(async () => (await pipeline.createShortlist({
      name: "Gap",
      entries: [{ targetId: target.id, position: 1 }]
    })), "VALIDATION_ERROR"));
    (await expectDomainError(async () => (await pipeline.createShortlist({
      name: "Negative",
      entries: [{ targetId: target.id, position: -1 }]
    })), "VALIDATION_ERROR"));
    (await expectDomainError(async () => (await pipeline.createShortlist({
      name: "Missing target",
      targetIds: [target.id, "missing-target"]
    })), "NOT_FOUND"));

    expect((await db.shortlists.list())).toEqual([]);
  });

  it("rejects malformed entry collections instead of treating them as empty", async () => {
    (await expectDomainError(async () => (await pipeline.createShortlist({
      name: "Malformed entries",
      entries: null
    } as never)), "VALIDATION_ERROR"));
    (await expectDomainError(async () => (await pipeline.createShortlist({
      name: "Malformed target IDs",
      targetIds: null
    } as never)), "VALIDATION_ERROR"));
    expect((await db.shortlists.list())).toEqual([]);
  });
});

describe("pipeline persistence error boundaries", () => {
  it.each(["retryable", "unknown"] as const)("sanitizes %s target-save failures", async (kind) => {
    const score = (await scoreFor(`save-failure-${kind}`));
    const spy = vi.spyOn(db.targets, "upsert").mockRejectedValue(repositoryFailure(kind));
    let error: DomainError;
    try {
      error = (await expectDomainError(
        async () => (await pipeline.saveTarget(score)),
        kind === "retryable" ? "CONFLICT" : "DATA_INTEGRITY"
      ));
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "target");
  });

  it.each(["retryable", "unknown"] as const)("sanitizes %s status-update failures", async (kind) => {
    const target = (await pipeline.saveTarget((await scoreFor(`status-failure-${kind}`))));
    const spy = vi.spyOn(db.targets, "updateStatus").mockRejectedValue(repositoryFailure(kind));
    let error: DomainError;
    try {
      error = (await expectDomainError(
        async () => (await pipeline.updateStatus(target.id, "shortlisted")),
        kind === "retryable" ? "CONFLICT" : "DATA_INTEGRITY"
      ));
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "target");
  });

  it.each(["retryable", "unknown"] as const)("sanitizes %s note-save failures", async (kind) => {
    const target = (await pipeline.saveTarget((await scoreFor(`note-failure-${kind}`))));
    const spy = vi.spyOn(db.notes, "add").mockRejectedValue(repositoryFailure(kind));
    let error: DomainError;
    try {
      error = (await expectDomainError(
        async () => (await pipeline.recordNote(target.id, "Private note")),
        kind === "retryable" ? "CONFLICT" : "DATA_INTEGRITY"
      ));
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "note");
  });

  it.each(["retryable", "unknown"] as const)("sanitizes %s shortlist-save failures", async (kind) => {
    const target = (await pipeline.saveTarget((await scoreFor(`shortlist-failure-${kind}`))));
    const spy = vi.spyOn(db.shortlists, "create").mockRejectedValue(repositoryFailure(kind));
    let error: DomainError;
    try {
      error = (await expectDomainError(
        async () => (await pipeline.createShortlist({ name: "Private shortlist", targetIds: [target.id] })),
        kind === "retryable" ? "CONFLICT" : "DATA_INTEGRITY"
      ));
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "shortlist");
  });
});
