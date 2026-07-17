import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/db/client.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  PIPELINE_STATUSES,
  PIPELINE_TRANSITIONS,
  createPipelineService
} from "../../src/pipeline/service.js";
import type { TargetScore } from "../../src/ranking/score-target.js";

const db = createDatabase(":memory:");
const pipeline = createPipelineService(db);

afterEach(() => db.resetForTests());
afterAll(() => db.close());

function addPerson(label: string, companyName = `Company ${label}`) {
  const company = db.companies.upsert({
    ycId: `yc-${label}`,
    name: companyName
  });
  const person = db.people.upsert({
    companyId: company.id,
    name: `Person ${label}`,
    role: "VP Product Marketing"
  });
  return { company, person };
}

function scoreFor(label: string, companyName = `Company ${label}`): TargetScore {
  const { company, person } = addPerson(label, companyName);
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

function expectDomainError(action: () => unknown, code: string): DomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

type PersistenceFailureKind = "busy" | "unknown";

const PRIVATE_PERSISTENCE_TEXT = "private-user-persistence-text";
const PRIVATE_DATABASE_PATH = "/private/path/career.sqlite";

function repositoryFailure(kind: PersistenceFailureKind): Error {
  const error = new Error(
    `${kind === "busy" ? "database is locked" : "database I/O failed"} at `
      + `${PRIVATE_DATABASE_PATH}: ${PRIVATE_PERSISTENCE_TEXT}`
  );
  Object.assign(error, {
    code: kind === "busy" ? "SQLITE_BUSY" : "SQLITE_IOERR",
    sql: `INSERT INTO private_table VALUES ('${PRIVATE_PERSISTENCE_TEXT}')`,
    userText: PRIVATE_PERSISTENCE_TEXT
  });
  error.stack = `${error.message}\nSQL INSERT at ${PRIVATE_DATABASE_PATH}`;
  return error;
}

function expectSanitizedPersistenceError(
  error: DomainError,
  kind: PersistenceFailureKind,
  entity: "target" | "note" | "shortlist"
): void {
  expect(error).toMatchObject({
    code: kind === "busy" ? "CONFLICT" : "DATA_INTEGRITY",
    message: kind === "busy"
      ? "Pipeline write could not be completed"
      : "Pipeline storage operation failed",
    details: { entity, retryable: kind === "busy" }
  });
  expect("cause" in error).toBe(false);
  const exposed = [
    error.code,
    error.message,
    JSON.stringify(error.details),
    error.stack ?? ""
  ].join("\n");
  expect(exposed).not.toContain(PRIVATE_PERSISTENCE_TEXT);
  expect(exposed).not.toContain(PRIVATE_DATABASE_PATH);
  expect(exposed).not.toContain("SQL INSERT");
  expect(exposed).not.toContain("SQLITE_BUSY");
  expect(exposed).not.toContain("SQLITE_IOERR");
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

  it("allows every documented forward transition", () => {
    const saved = pipeline.saveTarget(scoreFor("transitions"));

    for (const status of [
      "shortlisted",
      "connect_planned",
      "connected",
      "contacted",
      "replied",
      "archived"
    ] as const) {
      expect(pipeline.updateStatus(saved.id, status).status).toBe(status);
    }
  });

  it("rejects skips, reversals, and transitions out of archived with safe typed errors", () => {
    const saved = pipeline.saveTarget(scoreFor("invalid-transition"));
    const skip = expectDomainError(
      () => pipeline.updateStatus(saved.id, "connected"),
      "INVALID_TRANSITION"
    );
    expect(skip.message).toBe("Pipeline status transition is not allowed");
    expect(skip.details).toEqual({ from: "discovered", to: "connected" });

    const archived = pipeline.updateStatus(saved.id, "archived");
    expectDomainError(
      () => pipeline.updateStatus(archived.id, "discovered"),
      "INVALID_TRANSITION"
    );
  });

  it("rejects unknown statuses before persistence without reflecting input text", () => {
    const saved = pipeline.saveTarget(scoreFor("unknown-status"));
    const secret = "private-status-secret";
    const error = expectDomainError(
      () => pipeline.updateStatus(saved.id, secret as never),
      "VALIDATION_ERROR"
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
    expect(db.targets.get(saved.id)?.status).toBe("discovered");
  });

  it("treats same-status updates as idempotent no-ops", () => {
    const saved = pipeline.saveTarget(scoreFor("idempotent"));
    const unchanged = pipeline.updateStatus(saved.id, "discovered");

    expect(unchanged).toEqual(saved);
  });

  it("returns a typed not-found error for an unknown target", () => {
    const error = expectDomainError(
      () => pipeline.updateStatus("missing-target", "shortlisted"),
      "NOT_FOUND"
    );

    expect(error).toMatchObject({
      message: "Target was not found",
      details: { entity: "target" }
    });
  });

  it("keeps exported status policy frozen and validation independent from runtime mutation", () => {
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
        pipeline.listPipeline({ status: "private_runtime_status" as never });
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

  it("deep-freezes exported transitions and keeps authorization independent from mutation", () => {
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
      const saved = pipeline.saveTarget(scoreFor("runtime-transition-policy"));
      try {
        pipeline.updateStatus(saved.id, "connected");
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
  it("persists score components, confidence, and defensive explanation arrays", () => {
    const input = scoreFor("score");
    const before = structuredClone(input);
    const saved = pipeline.saveTarget(input);

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
    expect(pipeline.listPipeline()[0]?.reasons).not.toContain("Mutated after save");
  });

  it("preserves current status when an existing target score is refreshed", () => {
    const input = scoreFor("refresh");
    const first = pipeline.saveTarget(input);
    pipeline.updateStatus(first.id, "shortlisted");

    const refreshed = pipeline.saveTarget({
      ...input,
      pmmOpportunity: 35,
      total: 80,
      reasons: ["Updated evidence-backed reason"]
    });

    expect(refreshed).toMatchObject({
      id: first.id,
      status: "shortlisted",
      pmmOpportunity: 35,
      totalScore: 80,
      reasons: ["Updated evidence-backed reason"]
    });
  });

  it("filters by company and status and returns a deterministic company/person order", () => {
    const zeta = pipeline.saveTarget(scoreFor("zeta", "Zeta"));
    const alphaB = pipeline.saveTarget(scoreFor("b", "Alpha"));
    const alphaA = pipeline.saveTarget(scoreFor("a", "Alpha"));
    pipeline.updateStatus(alphaA.id, "shortlisted");
    pipeline.updateStatus(alphaB.id, "shortlisted");

    expect(pipeline.listPipeline().map((target) => target.id)).toEqual([
      alphaA.id,
      alphaB.id,
      zeta.id
    ]);
    expect(pipeline.listPipeline({ status: "shortlisted" }).map((target) => target.id)).toEqual([
      alphaA.id,
      alphaB.id
    ]);
    expect(pipeline.listPipeline({ companyId: scoreCompanyId("zeta") })).toEqual([zeta]);
  });

  function scoreCompanyId(label: string): string {
    return db.companies.getByYcId(`yc-${label}`)!.id;
  }

  it("validates filter lengths and status without exposing supplied filter text", () => {
    const privateFilter = "x".repeat(257);
    const error = expectDomainError(
      () => pipeline.listPipeline({ companyId: privateFilter }),
      "VALIDATION_ERROR"
    );

    expect(error.message).not.toContain(privateFilter);
    expect(JSON.stringify(error.details)).not.toContain(privateFilter);
    expectDomainError(
      () => pipeline.listPipeline({ status: "not-a-status" as never }),
      "VALIDATION_ERROR"
    );
  });

  it("rejects a non-object filter with a typed validation error", () => {
    expectDomainError(() => pipeline.listPipeline(null as never), "VALIDATION_ERROR");
  });
});

describe("notes", () => {
  it("appends normalized notes in stable call order and returns saved timestamps", () => {
    const target = pipeline.saveTarget(scoreFor("notes"));
    const first = pipeline.recordNote(target.id, "  Met at a PMM event  ");
    const second = pipeline.recordNote(target.id, "Follow up next week");

    expect(first).toMatchObject({ text: "Met at a PMM event", updatedAt: first.createdAt });
    expect(second).toMatchObject({ text: "Follow up next week", updatedAt: second.createdAt });
    expect(db.notes.listForTarget(target.id).map((note) => note.text)).toEqual([
      "Met at a PMM event",
      "Follow up next week"
    ]);
  });

  it("rejects missing targets and empty or oversized note text safely", () => {
    expectDomainError(() => pipeline.recordNote("missing", "hello"), "NOT_FOUND");
    const target = pipeline.saveTarget(scoreFor("invalid-notes"));
    expectDomainError(() => pipeline.recordNote(target.id, "   "), "VALIDATION_ERROR");

    const privateText = "private".repeat(800);
    const error = expectDomainError(
      () => pipeline.recordNote(target.id, privateText),
      "VALIDATION_ERROR"
    );
    expect(error.message).not.toContain(privateText);
    expect(JSON.stringify(error.details)).not.toContain(privateText);
  });
});

describe("shortlists", () => {
  it("validates and persists explicit positions in position order", () => {
    const first = pipeline.saveTarget(scoreFor("shortlist-1"));
    const second = pipeline.saveTarget(scoreFor("shortlist-2"));
    const input = {
      name: "  Weekly shortlist  ",
      entries: [
        { targetId: first.id, position: 1 },
        { targetId: second.id, position: 0 }
      ]
    };
    const before = structuredClone(input);

    const shortlist = pipeline.createShortlist(input);

    expect(shortlist).toMatchObject({ name: "Weekly shortlist" });
    expect(shortlist.entries.map(({ targetId, position }) => ({ targetId, position }))).toEqual([
      { targetId: second.id, position: 0 },
      { targetId: first.id, position: 1 }
    ]);
    expect(input).toEqual(before);
  });

  it("supports ordered target IDs without mutating them", () => {
    const first = pipeline.saveTarget(scoreFor("ids-1"));
    const second = pipeline.saveTarget(scoreFor("ids-2"));
    const targetIds = [second.id, first.id];

    const shortlist = pipeline.createShortlist({ name: "By IDs", targetIds });

    expect(shortlist.entries.map((entry) => entry.targetId)).toEqual(targetIds);
    expect(targetIds).toEqual([second.id, first.id]);
  });

  it("rejects duplicate target IDs or positions before creating anything", () => {
    const target = pipeline.saveTarget(scoreFor("duplicates"));

    expectDomainError(() => pipeline.createShortlist({
      name: "Duplicate targets",
      targetIds: [target.id, target.id]
    }), "CONFLICT");
    expectDomainError(() => pipeline.createShortlist({
      name: "Duplicate positions",
      entries: [
        { targetId: target.id, position: 0 },
        { targetId: "other", position: 0 }
      ]
    }), "CONFLICT");
    expect(db.shortlists.list()).toEqual([]);
  });

  it("rejects gaps, negative positions, missing targets, and rolls back atomically", () => {
    const target = pipeline.saveTarget(scoreFor("rollback"));
    expectDomainError(() => pipeline.createShortlist({
      name: "Gap",
      entries: [{ targetId: target.id, position: 1 }]
    }), "VALIDATION_ERROR");
    expectDomainError(() => pipeline.createShortlist({
      name: "Negative",
      entries: [{ targetId: target.id, position: -1 }]
    }), "VALIDATION_ERROR");
    expectDomainError(() => pipeline.createShortlist({
      name: "Missing target",
      targetIds: [target.id, "missing-target"]
    }), "NOT_FOUND");

    expect(db.shortlists.list()).toEqual([]);
  });

  it("rejects malformed entry collections instead of treating them as empty", () => {
    expectDomainError(() => pipeline.createShortlist({
      name: "Malformed entries",
      entries: null
    } as never), "VALIDATION_ERROR");
    expectDomainError(() => pipeline.createShortlist({
      name: "Malformed target IDs",
      targetIds: null
    } as never), "VALIDATION_ERROR");
    expect(db.shortlists.list()).toEqual([]);
  });
});

describe("pipeline persistence error boundaries", () => {
  it.each(["busy", "unknown"] as const)("sanitizes %s target-save failures", (kind) => {
    const score = scoreFor(`save-failure-${kind}`);
    const spy = vi.spyOn(db.targets, "upsert").mockImplementation(() => {
      throw repositoryFailure(kind);
    });
    let error: DomainError;
    try {
      error = expectDomainError(
        () => pipeline.saveTarget(score),
        kind === "busy" ? "CONFLICT" : "DATA_INTEGRITY"
      );
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "target");
  });

  it.each(["busy", "unknown"] as const)("sanitizes %s status-update failures", (kind) => {
    const target = pipeline.saveTarget(scoreFor(`status-failure-${kind}`));
    const spy = vi.spyOn(db.targets, "updateStatus").mockImplementation(() => {
      throw repositoryFailure(kind);
    });
    let error: DomainError;
    try {
      error = expectDomainError(
        () => pipeline.updateStatus(target.id, "shortlisted"),
        kind === "busy" ? "CONFLICT" : "DATA_INTEGRITY"
      );
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "target");
  });

  it.each(["busy", "unknown"] as const)("sanitizes %s note-save failures", (kind) => {
    const target = pipeline.saveTarget(scoreFor(`note-failure-${kind}`));
    const spy = vi.spyOn(db.notes, "add").mockImplementation(() => {
      throw repositoryFailure(kind);
    });
    let error: DomainError;
    try {
      error = expectDomainError(
        () => pipeline.recordNote(target.id, "Private note"),
        kind === "busy" ? "CONFLICT" : "DATA_INTEGRITY"
      );
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "note");
  });

  it.each(["busy", "unknown"] as const)("sanitizes %s shortlist-save failures", (kind) => {
    const target = pipeline.saveTarget(scoreFor(`shortlist-failure-${kind}`));
    const spy = vi.spyOn(db.shortlists, "create").mockImplementation(() => {
      throw repositoryFailure(kind);
    });
    let error: DomainError;
    try {
      error = expectDomainError(
        () => pipeline.createShortlist({ name: "Private shortlist", targetIds: [target.id] }),
        kind === "busy" ? "CONFLICT" : "DATA_INTEGRITY"
      );
    } finally {
      spy.mockRestore();
    }

    expectSanitizedPersistenceError(error!, kind, "shortlist");
  });
});
