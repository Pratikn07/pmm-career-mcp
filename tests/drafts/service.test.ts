import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/client.js";
import {
  POST_CHECKSUM_CONTRACT,
  computePostChecksum,
  createDraftService
} from "../../src/drafts/service.js";
import { DomainError } from "../../src/domain/errors.js";

const db = createDatabase(":memory:");
const drafts = createDraftService(db);

afterEach(() => db.resetForTests());
afterAll(() => db.close());

function addTarget(label: string) {
  const company = db.companies.upsert({ ycId: `yc-${label}`, name: `Company ${label}` });
  const person = db.people.upsert({
    companyId: company.id,
    name: `Person ${label}`,
    role: "VP Product Marketing"
  });
  const evidence = db.evidence.add({
    personId: person.id,
    sourceUrl: `https://company.example/${label}`,
    fact: `${person.name} is VP Product Marketing`,
    checkedAt: "2026-07-16T00:00:00.000Z",
    confidence: 0.9
  });
  const target = db.targets.upsert({
    personId: person.id,
    pmmOpportunity: 30,
    referralPotential: 25,
    networkValue: 20,
    totalScore: 75,
    confidence: 0.9,
    status: "discovered",
    rationale: JSON.stringify({ version: 1, reasons: ["Verified role"], missingEvidence: [] })
  });
  return { company, person, evidence, target };
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

describe("outreach drafts", () => {
  it("requires owned evidence and creates immutable, sequential versions", () => {
    const { target, evidence } = addTarget("outreach");
    const input = {
      targetId: target.id,
      purpose: "  connection_note  ",
      text: "  Hello — I appreciated your product launch.  ",
      evidenceIds: [evidence.id]
    };
    const before = structuredClone(input);

    const first = drafts.createOutreach(input);
    const second = drafts.createOutreach({
      targetId: target.id,
      purpose: "connection_note",
      text: "Hello — revised",
      evidenceIds: [evidence.id]
    });

    expect(first).toMatchObject({
      targetId: target.id,
      purpose: "connection_note",
      text: "Hello — I appreciated your product launch.",
      evidenceIds: [evidence.id],
      version: 1
    });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.version).toBe(2);
    expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
    expect(new Date(first.updatedAt).toISOString()).toBe(first.updatedAt);
    expect(db.outreachDrafts.getVersion(target.id, "connection_note", 1)?.text).toBe(first.text);
    expect(db.outreachDrafts.getVersion(target.id, "connection_note", 2)?.text).toBe(second.text);
    expect(input).toEqual(before);

    input.evidenceIds.push("mutated-after-save");
    expect(db.outreachDrafts.getVersion(target.id, "connection_note", 1)?.evidenceIds).toEqual([
      evidence.id
    ]);
  });

  it("keeps version sequences independent by normalized purpose", () => {
    const { target, evidence } = addTarget("purpose-sequences");
    const evidenceIds = [evidence.id];

    const connection = drafts.createOutreach({
      targetId: target.id,
      purpose: "connection_note",
      text: "Connection",
      evidenceIds
    });
    const followUp = drafts.createOutreach({
      targetId: target.id,
      purpose: "follow_up",
      text: "Follow up",
      evidenceIds
    });
    const revisedConnection = drafts.createOutreach({
      targetId: target.id,
      purpose: "connection_note",
      text: "Connection v2",
      evidenceIds
    });

    expect([connection.version, followUp.version, revisedConnection.version]).toEqual([1, 1, 2]);
  });

  it("rejects unknown targets, missing evidence, and evidence owned by another person", () => {
    const first = addTarget("evidence-owner-1");
    const second = addTarget("evidence-owner-2");

    expectDomainError(() => drafts.createOutreach({
      targetId: "missing-target",
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: [first.evidence.id]
    }), "NOT_FOUND");
    expectDomainError(() => drafts.createOutreach({
      targetId: first.target.id,
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: ["missing-evidence"]
    }), "NOT_FOUND");
    const mismatch = expectDomainError(() => drafts.createOutreach({
      targetId: first.target.id,
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: [second.evidence.id]
    }), "EVIDENCE_MISMATCH");
    expect(mismatch).toMatchObject({
      message: "Evidence does not belong to the target person",
      details: { entity: "evidence" }
    });
    expect(db.outreachDrafts.listForTarget(first.target.id)).toEqual([]);
  });

  it("rejects absent, duplicate, empty, and oversized evidence or text fields safely", () => {
    const { target, evidence } = addTarget("outreach-validation");
    const base = {
      targetId: target.id,
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: [evidence.id]
    };
    expectDomainError(
      () => drafts.createOutreach({ ...base, evidenceIds: [] }),
      "VALIDATION_ERROR"
    );
    expectDomainError(
      () => drafts.createOutreach({ ...base, evidenceIds: [evidence.id, evidence.id] }),
      "CONFLICT"
    );
    expectDomainError(
      () => drafts.createOutreach({ ...base, purpose: "   " }),
      "VALIDATION_ERROR"
    );
    expectDomainError(
      () => drafts.createOutreach({ ...base, text: "   " }),
      "VALIDATION_ERROR"
    );

    const privateText = "private-outreach".repeat(300);
    const error = expectDomainError(
      () => drafts.createOutreach({ ...base, text: privateText }),
      "VALIDATION_ERROR"
    );
    expect(error.message).not.toContain(privateText);
    expect(JSON.stringify(error.details)).not.toContain(privateText);
  });
});

describe("post drafts", () => {
  it("creates a text-only v1 draft with logical and version-row IDs made explicit", () => {
    const input = { text: "  Launch update\r\nSecond line  ", visibility: "PUBLIC" as const };
    const before = structuredClone(input);

    const post = drafts.createPost(input);

    expect(post).toMatchObject({
      text: "Launch update\nSecond line",
      visibility: "PUBLIC",
      version: 1,
      state: "draft"
    });
    expect(post.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.versionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.id).not.toBe(post.versionId);
    expect(post.checksum).toBe(computePostChecksum(post.text, post.version));
    expect(new Date(post.createdAt).toISOString()).toBe(post.createdAt);
    expect(new Date(post.updatedAt).toISOString()).toBe(post.updatedAt);
    expect(db.postDrafts.getVersion(post.id, 1)).toMatchObject({
      id: post.versionId,
      draftId: post.id
    });
    expect(input).toEqual(before);
  });

  it("uses the documented exact-text/version checksum contract", () => {
    const exactText = "Café\n🙂 exact  spacing";
    const version = 42;
    const canonical = [
      POST_CHECKSUM_CONTRACT,
      String(version),
      String(Buffer.byteLength(exactText, "utf8")),
      exactText
    ].join("\u0000");
    const expected = createHash("sha256").update(canonical, "utf8").digest("hex");

    expect(computePostChecksum(exactText, version)).toBe(expected);
    expect(computePostChecksum(`${exactText} `, version)).not.toBe(expected);
    expect(computePostChecksum(exactText, version + 1)).not.toBe(expected);
  });

  it("revises by logical draft ID and preserves immutable exact versions", () => {
    const first = drafts.createPost({ text: "First", visibility: "CONNECTIONS" });
    const second = drafts.revisePost(first.id, "Second");

    expect(second).toMatchObject({
      id: first.id,
      visibility: "CONNECTIONS",
      text: "Second",
      version: 2,
      state: "draft"
    });
    expect(second.versionId).not.toBe(first.versionId);
    expect(drafts.getPostVersion(first.id, 1)?.text).toBe("First");
    expect(drafts.getPostVersion(first.id, 2)?.text).toBe("Second");
    expect(drafts.getPostHistory(first.id).map((post) => post.version)).toEqual([1, 2]);
    expect(drafts.getPostVersion(first.id, 1)).toEqual(first);
  });

  it("allocates contiguous versions and checksums from each actual version", () => {
    const first = drafts.createPost({ text: "Version 1", visibility: "PUBLIC" });
    const revisions = Array.from({ length: 20 }, (_, index) => (
      drafts.revisePost(first.id, `Version ${index + 2}`)
    ));
    const history = drafts.getPostHistory(first.id);

    expect(history.map((post) => post.version)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1)
    );
    expect(revisions.at(-1)?.version).toBe(21);
    for (const post of history) {
      expect(post.checksum).toBe(computePostChecksum(post.text, post.version));
    }
  });

  it("returns stable defensive history ordered by version", () => {
    const first = drafts.createPost({ text: "First", visibility: "PUBLIC" });
    drafts.revisePost(first.id, "Second");
    const history = drafts.getPostHistory(first.id);
    history.reverse();

    expect(drafts.getPostHistory(first.id).map((post) => post.version)).toEqual([1, 2]);
  });

  it.each(["PUBLIC", "CONNECTIONS"] as const)("supports %s visibility", (visibility) => {
    expect(drafts.createPost({ text: "Visible", visibility }).visibility).toBe(visibility);
  });

  it("rejects unsupported visibility, blank text, media, extra fields, and oversized text", () => {
    expectDomainError(() => drafts.createPost({
      text: "Private",
      visibility: "PRIVATE" as never
    }), "VALIDATION_ERROR");
    expectDomainError(() => drafts.createPost({
      text: "   \r\n  ",
      visibility: "PUBLIC"
    }), "VALIDATION_ERROR");
    expectDomainError(() => drafts.createPost({
      text: "Media",
      visibility: "PUBLIC",
      media: { image: "bytes" }
    } as never), "VALIDATION_ERROR");
    expectDomainError(() => drafts.createPost({
      text: "Unexpected",
      visibility: "PUBLIC",
      unrecognized: true
    } as never), "VALIDATION_ERROR");

    const privateText = "x".repeat(3_001);
    const error = expectDomainError(() => drafts.createPost({
      text: privateText,
      visibility: "PUBLIC"
    }), "VALIDATION_ERROR");
    expect(error.message).not.toContain(privateText);
    expect(JSON.stringify(error.details)).not.toContain(privateText);
  });

  it("rejects invalid revision text without changing history", () => {
    const first = drafts.createPost({ text: "First", visibility: "PUBLIC" });
    expectDomainError(() => drafts.revisePost(first.id, "   "), "VALIDATION_ERROR");
    expectDomainError(() => drafts.revisePost(first.id, "x".repeat(3_001)), "VALIDATION_ERROR");

    expect(drafts.getPostHistory(first.id)).toEqual([first]);
  });

  it("handles missing drafts and versions without creating accidental drafts", () => {
    const error = expectDomainError(
      () => drafts.revisePost("missing-draft", "Second"),
      "NOT_FOUND"
    );
    expect(error).toMatchObject({
      message: "Post draft was not found",
      details: { entity: "post_draft" }
    });
    expect(drafts.getPostVersion("missing-draft", 1)).toBeUndefined();
    expect(drafts.getPostHistory("missing-draft")).toEqual([]);

    const first = drafts.createPost({ text: "First", visibility: "PUBLIC" });
    expect(drafts.getPostVersion(first.id, 2)).toBeUndefined();
    expectDomainError(() => drafts.getPostVersion(first.id, 0), "VALIDATION_ERROR");
    expect(drafts.getPostHistory(first.id)).toEqual([first]);
  });
});
