import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../support/database.js";
import {
  POST_CHECKSUM_CONTRACT,
  POST_VISIBILITIES,
  computePostChecksum,
  createDraftService
} from "../../src/drafts/service.js";
import { DomainError } from "../../src/domain/errors.js";
import { checksumLinkedInPost } from "../../src/posts/post-checksum.js";

const db = await createTestDatabase();
const drafts = createDraftService(db);

afterEach(async () => (await db.resetForTests()));
afterAll(async () => (await db.close()));

async function addTarget(label: string) {
  const company = (await db.companies.upsert({ ycId: `yc-${label}`, name: `Company ${label}` }));
  const person = (await db.people.upsert({
    companyId: company.id,
    name: `Person ${label}`,
    role: "VP Product Marketing"
  }));
  const evidence = (await db.evidence.add({
    personId: person.id,
    sourceUrl: `https://company.example/${label}`,
    fact: `${person.name} is VP Product Marketing`,
    checkedAt: "2026-07-16T00:00:00.000Z",
    confidence: 0.9
  }));
  const target = (await db.targets.upsert({
    personId: person.id,
    pmmOpportunity: 30,
    referralPotential: 25,
    networkValue: 20,
    totalScore: 75,
    confidence: 0.9,
    rationale: JSON.stringify({ version: 1, reasons: ["Verified role"], missingEvidence: [] })
  }));
  return { company, person, evidence, target };
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

describe("outreach drafts", () => {
  it("requires owned evidence and creates immutable, sequential versions", async () => {
    const { target, evidence } = (await addTarget("outreach"));
    const input = {
      targetId: target.id,
      purpose: "  connection_note  ",
      text: "  Hello — I appreciated your product launch.  ",
      evidenceIds: [evidence.id]
    };
    const before = structuredClone(input);

    const first = (await drafts.createOutreach(input));
    const second = (await drafts.createOutreach({
      targetId: target.id,
      purpose: "connection_note",
      text: "Hello — revised",
      evidenceIds: [evidence.id]
    }));

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
    expect((await db.outreachDrafts.getVersion(target.id, "connection_note", 1))?.text).toBe(first.text);
    expect((await db.outreachDrafts.getVersion(target.id, "connection_note", 2))?.text).toBe(second.text);
    expect(input).toEqual(before);

    input.evidenceIds.push("mutated-after-save");
    expect((await db.outreachDrafts.getVersion(target.id, "connection_note", 1))?.evidenceIds).toEqual([
      evidence.id
    ]);
  });

  it("keeps version sequences independent by normalized purpose", async () => {
    const { target, evidence } = (await addTarget("purpose-sequences"));
    const evidenceIds = [evidence.id];

    const connection = (await drafts.createOutreach({
      targetId: target.id,
      purpose: "connection_note",
      text: "Connection",
      evidenceIds
    }));
    const followUp = (await drafts.createOutreach({
      targetId: target.id,
      purpose: "follow_up",
      text: "Follow up",
      evidenceIds
    }));
    const revisedConnection = (await drafts.createOutreach({
      targetId: target.id,
      purpose: "connection_note",
      text: "Connection v2",
      evidenceIds
    }));

    expect([connection.version, followUp.version, revisedConnection.version]).toEqual([1, 1, 2]);
  });

  it("rejects unknown targets, missing evidence, and evidence owned by another person", async () => {
    const first = (await addTarget("evidence-owner-1"));
    const second = (await addTarget("evidence-owner-2"));

    (await expectDomainError(async () => (await drafts.createOutreach({
      targetId: "missing-target",
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: [first.evidence.id]
    })), "NOT_FOUND"));
    (await expectDomainError(async () => (await drafts.createOutreach({
      targetId: first.target.id,
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: ["missing-evidence"]
    })), "NOT_FOUND"));
    const mismatch = (await expectDomainError(async () => (await drafts.createOutreach({
      targetId: first.target.id,
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: [second.evidence.id]
    })), "EVIDENCE_MISMATCH"));
    expect(mismatch).toMatchObject({
      message: "Evidence does not belong to the target person",
      details: { entity: "evidence" }
    });
    expect((await db.outreachDrafts.listForTarget(first.target.id))).toEqual([]);
  });

  it("rejects absent, duplicate, empty, and oversized evidence or text fields safely", async () => {
    const { target, evidence } = (await addTarget("outreach-validation"));
    const base = {
      targetId: target.id,
      purpose: "connection_note",
      text: "Hello",
      evidenceIds: [evidence.id]
    };
    (await expectDomainError(
      async () => (await drafts.createOutreach({ ...base, evidenceIds: [] })),
      "VALIDATION_ERROR"
    ));
    (await expectDomainError(
      async () => (await drafts.createOutreach({ ...base, evidenceIds: [evidence.id, evidence.id] })),
      "CONFLICT"
    ));
    (await expectDomainError(
      async () => (await drafts.createOutreach({ ...base, purpose: "   " })),
      "VALIDATION_ERROR"
    ));
    (await expectDomainError(
      async () => (await drafts.createOutreach({ ...base, text: "   " })),
      "VALIDATION_ERROR"
    ));

    const privateText = "private-outreach".repeat(300);
    const error = (await expectDomainError(
      async () => (await drafts.createOutreach({ ...base, text: privateText })),
      "VALIDATION_ERROR"
    ));
    expect(error.message).not.toContain(privateText);
    expect(JSON.stringify(error.details)).not.toContain(privateText);
  });
});

describe("post drafts", () => {
  it("creates a text-only v1 draft with logical and version-row IDs made explicit", async () => {
    const input = { text: "  Launch update\r\nSecond line  ", visibility: "PUBLIC" as const };
    const before = structuredClone(input);

    const post = (await drafts.createPost(input));

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
    expect((await db.postDrafts.getVersion(post.id, 1))).toMatchObject({
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

  it("revises by logical draft ID and preserves immutable exact versions", async () => {
    const first = (await drafts.createPost({ text: "First", visibility: "CONNECTIONS" }));
    const second = (await drafts.revisePost(first.id, "Second"));

    expect(second).toMatchObject({
      id: first.id,
      visibility: "CONNECTIONS",
      text: "Second",
      version: 2,
      state: "draft"
    });
    expect(second.versionId).not.toBe(first.versionId);
    expect((await drafts.getPostVersion(first.id, 1))?.text).toBe("First");
    expect((await drafts.getPostVersion(first.id, 2))?.text).toBe("Second");
    expect((await drafts.getPostHistory(first.id)).map((post) => post.version)).toEqual([1, 2]);
    expect((await drafts.getPostVersion(first.id, 1))).toEqual(first);
    expect(first.media).toEqual([]);
    expect(second.media).toEqual([]);
    expect(second.checksum).toBe(checksumLinkedInPost({
      draftId: second.id,
      version: second.version,
      text: second.text,
      visibility: second.visibility,
      media: []
    }));
  });

  it("copies ordered media into a new v2 version when revising post text", async () => {
    const ownerSubject = randomUUID();
    const first = await drafts.createPost({ text: "First with images", visibility: "PUBLIC" });
    const stored = await Promise.all(["a", "b"].map(async (digit, index) => db.postMedia.create({
      id: randomUUID(),
      ownerSubject,
      objectPath: `${ownerSubject}/${digit}${digit}/${randomUUID()}.png`,
      sha256: digit.repeat(64),
      mimeType: "image/png",
      byteSize: 3,
      width: 1,
      height: 1,
      frameCount: 1,
      originalFilename: `image-${index + 1}.png`
    })));
    const mediaVersion = await db.postDrafts.createVersionWithMedia({
      draftId: first.id,
      expectedVersion: first.version,
      ownerSubject,
      text: first.text,
      visibility: first.visibility,
      checksum: (version, draftId, media) => checksumLinkedInPost({
        draftId,
        version,
        text: first.text,
        visibility: first.visibility,
        media: media.map(({ position, sha256, mimeType, altText }) => ({
          position,
          sha256,
          mimeType: mimeType as "image/png",
          altText
        }))
      }),
      state: "draft",
      media: stored.map((item, index) => ({ mediaId: item.id, altText: `Image ${index + 1}` }))
    });

    const revised = await drafts.revisePost(first.id, "Revised with images");
    expect(revised.version).toBe(3);
    expect(revised.media.map(({ mediaId, position, altText }) => ({ mediaId, position, altText }))).toEqual([
      { mediaId: stored[0]!.id, position: 0, altText: "Image 1" },
      { mediaId: stored[1]!.id, position: 1, altText: "Image 2" }
    ]);
    expect(revised.checksum).toBe(checksumLinkedInPost({
      draftId: revised.id,
      version: revised.version,
      text: revised.text,
      visibility: revised.visibility,
      media: revised.media
    }));
    expect((await db.postDraftMedia.listForVersion(
      mediaVersion.post.id,
      mediaVersion.post.version
    )).map(({ mediaId }) => mediaId)).toEqual(stored.map(({ id }) => id));
  });

  it("rejects a text revision if media changes after its outside read", async () => {
    const ownerSubject = randomUUID();
    const first = await drafts.createPost({ text: "Concurrent base", visibility: "PUBLIC" });
    const stored = await Promise.all(["c", "d"].map(async (digit) => db.postMedia.create({
      id: randomUUID(),
      ownerSubject,
      objectPath: `${ownerSubject}/${digit}${digit}/${randomUUID()}.png`,
      sha256: digit.repeat(64),
      mimeType: "image/png",
      byteSize: 3,
      width: 1,
      height: 1,
      frameCount: 1
    })));
    const withMedia = await db.postDrafts.createVersionWithMedia({
      draftId: first.id,
      expectedVersion: first.version,
      ownerSubject,
      text: first.text,
      visibility: first.visibility,
      checksum: "media-v2",
      state: "draft",
      media: stored.map((item, index) => ({ mediaId: item.id, altText: `Image ${index + 1}` }))
    });
    let interleaved = false;
    const racingDatabase = {
      ...db,
      postDraftMedia: {
        ...db.postDraftMedia,
        listForVersion: async (versionId: string, version: number) => {
          const rows = await db.postDraftMedia.listForVersion(versionId, version);
          if (!interleaved && versionId === withMedia.post.id && version === withMedia.post.version) {
            interleaved = true;
            await db.postDrafts.createVersionWithMedia({
              draftId: first.id,
              expectedVersion: withMedia.post.version,
              ownerSubject,
              text: first.text,
              visibility: first.visibility,
              checksum: "concurrent-media-v3",
              state: "draft",
              media: [...stored].reverse().map((item, index) => ({
                mediaId: item.id,
                altText: `Reordered ${index + 1}`
              }))
            });
          }
          return rows;
        }
      }
    } as typeof db;
    const racingDrafts = createDraftService(racingDatabase);

    await expectDomainError(
      () => racingDrafts.revisePost(first.id, "Must not restore stale media"),
      "CONFLICT"
    );
    expect((await db.postDrafts.listVersions(first.id)).map(({ version }) => version)).toEqual([1, 2, 3]);
    expect((await db.postDraftMedia.listForVersion(
      (await db.postDrafts.getVersion(first.id, 3))!.id,
      3
    )).map(({ mediaId }) => mediaId)).toEqual([...stored].reverse().map(({ id }) => id));
  });

  it("allocates contiguous versions and checksums from each actual version", async () => {
    const first = (await drafts.createPost({ text: "Version 1", visibility: "PUBLIC" }));
    const revisions = [];
    for (let index = 0; index < 20; index += 1) {
      revisions.push(await drafts.revisePost(first.id, `Version ${index + 2}`));
    }
    const history = (await drafts.getPostHistory(first.id));

    expect(history.map((post) => post.version)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1)
    );
    expect(revisions.at(-1)?.version).toBe(21);
    for (const post of history) {
      expect(post.checksum).toBe(post.version === 1
        ? computePostChecksum(post.text, post.version)
        : checksumLinkedInPost({
            draftId: post.id,
            version: post.version,
            text: post.text,
            visibility: post.visibility,
            media: []
          }));
    }
  });

  it("returns stable defensive history ordered by version", async () => {
    const first = (await drafts.createPost({ text: "First", visibility: "PUBLIC" }));
    (await drafts.revisePost(first.id, "Second"));
    const history = (await drafts.getPostHistory(first.id));
    history.reverse();

    expect((await drafts.getPostHistory(first.id)).map((post) => post.version)).toEqual([1, 2]);
  });

  it.each(["PUBLIC", "CONNECTIONS"] as const)("supports %s visibility", async (visibility) => {
    expect((await drafts.createPost({ text: "Visible", visibility })).visibility).toBe(visibility);
  });

  it("freezes exported visibilities and keeps validation independent from runtime mutation", async () => {
    const original = [...POST_VISIBILITIES];
    const mutableVisibilities = POST_VISIBILITIES as unknown as string[];
    let mutationThrew = false;
    let validationError: DomainError | undefined;

    try {
      try {
        mutableVisibilities.push("PRIVATE");
      } catch (error) {
        mutationThrew = error instanceof TypeError;
      }
      try {
        (await drafts.createPost({ text: "Private", visibility: "PRIVATE" as never }));
      } catch (error) {
        validationError = error as DomainError;
      }
    } finally {
      if (!Object.isFrozen(POST_VISIBILITIES)) {
        mutableVisibilities.splice(0, mutableVisibilities.length, ...original);
      }
    }

    expect(Object.isFrozen(POST_VISIBILITIES)).toBe(true);
    expect(mutationThrew).toBe(true);
    expect(POST_VISIBILITIES).toEqual(original);
    expect(validationError).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects unsupported visibility, blank text, media, extra fields, and oversized text", async () => {
    (await expectDomainError(async () => (await drafts.createPost({
      text: "Private",
      visibility: "PRIVATE" as never
    })), "VALIDATION_ERROR"));
    (await expectDomainError(async () => (await drafts.createPost({
      text: "   \r\n  ",
      visibility: "PUBLIC"
    })), "VALIDATION_ERROR"));
    (await expectDomainError(async () => (await drafts.createPost({
      text: "Media",
      visibility: "PUBLIC",
      media: { image: "bytes" }
    } as never)), "VALIDATION_ERROR"));
    (await expectDomainError(async () => (await drafts.createPost({
      text: "Unexpected",
      visibility: "PUBLIC",
      unrecognized: true
    } as never)), "VALIDATION_ERROR"));

    const privateText = "x".repeat(3_001);
    const error = (await expectDomainError(async () => (await drafts.createPost({
      text: privateText,
      visibility: "PUBLIC"
    })), "VALIDATION_ERROR"));
    expect(error.message).not.toContain(privateText);
    expect(JSON.stringify(error.details)).not.toContain(privateText);
  });

  it("rejects invalid revision text without changing history", async () => {
    const first = (await drafts.createPost({ text: "First", visibility: "PUBLIC" }));
    (await expectDomainError(async () => (await drafts.revisePost(first.id, "   ")), "VALIDATION_ERROR"));
    (await expectDomainError(async () => (await drafts.revisePost(first.id, "x".repeat(3_001))), "VALIDATION_ERROR"));

    expect((await drafts.getPostHistory(first.id))).toEqual([first]);
  });

  it("handles missing drafts and versions without creating accidental drafts", async () => {
    const error = (await expectDomainError(
      async () => (await drafts.revisePost("missing-draft", "Second")),
      "NOT_FOUND"
    ));
    expect(error).toMatchObject({
      message: "Post draft was not found",
      details: { entity: "post_draft" }
    });
    expect((await drafts.getPostVersion("missing-draft", 1))).toBeUndefined();
    expect((await drafts.getPostHistory("missing-draft"))).toEqual([]);

    const first = (await drafts.createPost({ text: "First", visibility: "PUBLIC" }));
    expect((await drafts.getPostVersion(first.id, 2))).toBeUndefined();
    (await expectDomainError(async () => (await drafts.getPostVersion(first.id, 0)), "VALIDATION_ERROR"));
    expect((await drafts.getPostHistory(first.id))).toEqual([first]);
  });
});
