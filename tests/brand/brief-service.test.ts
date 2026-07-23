import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBrandBriefService,
  type CreateBrandVisualBriefInput
} from "../../src/brand/brief-service.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

let db: TestCareerDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterEach(async () => {
  await db.resetForTests();
});
afterAll(async () => {
  await db?.close();
});

async function addMedia(ownerSubject: string) {
  const id = randomUUID();
  const sha256 = randomUUID().replaceAll("-", "").padEnd(64, "0");
  return db.postMedia.create({
    id,
    ownerSubject,
    objectPath: `${ownerSubject}/${sha256.slice(0, 2)}/${id}.png`,
    sha256,
    mimeType: "image/png",
    byteSize: 1024,
    width: 1200,
    height: 627,
    frameCount: 1
  });
}

async function addOwnedPost(
  ownerSubject: string,
  options: {
    draftId?: string;
    text?: string;
    expectedVersion?: number;
    mediaId?: string;
  } = {}
) {
  const mediaId = options.mediaId ?? (await addMedia(ownerSubject)).id;
  return (await db.postDrafts.createVersionWithMedia({
    ...(options.draftId === undefined ? {} : { draftId: options.draftId }),
    ...(options.expectedVersion === undefined
      ? {}
      : { expectedVersion: options.expectedVersion }),
    ownerSubject,
    text: options.text ?? "Positioning improves when teams choose one clear audience.",
    visibility: "PUBLIC",
    checksum: `brand-brief-source-${randomUUID()}`,
    state: "draft",
    media: [{ mediaId, altText: "Private draft source" }]
  })).post;
}

function statementInput(
  postId: string,
  expectedVersion: number,
  overrides: Partial<CreateBrandVisualBriefInput> = {}
): CreateBrandVisualBriefInput {
  return {
    postId,
    expectedVersion,
    coverHook: "Clarity beats capability.",
    conceptSummary: "Restrained editorial geometry about choosing clarity",
    visualMode: "EDITORIAL_STATEMENT",
    topicLabel: "Positioning",
    ...overrides
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
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

describe("Brand brief service", () => {
  it("returns the effective canonical profile without initializing persistence", async () => {
    const owner = randomUUID();
    const service = createBrandBriefService(db, { subject: owner });

    const profile = await service.getProfile();

    expect(profile).toMatchObject({
      version: 1,
      publicName: "BHAGYASHREE NANDOSKAR",
      roleLine: "PRODUCT MARKETING",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN",
      recentUsage: []
    });
    expect(Object.keys(profile).sort()).toEqual([
      "hookRules",
      "monogram",
      "palette",
      "publicName",
      "recentUsage",
      "roleLine",
      "seriesName",
      "version",
      "voice"
    ]);
    expect(await queryTestDatabase(db, "select id from career_mcp.brand_profiles")).toEqual([]);
  });

  it("initializes version one on the first brief write and saves a statement brief", async () => {
    const owner = randomUUID();
    const briefId = randomUUID();
    const post = await addOwnedPost(owner);
    const service = createBrandBriefService(db, {
      subject: owner,
      createId: () => briefId
    });

    const result = await service.createBrief(statementInput(post.draftId, post.version));

    expect(result.brief).toMatchObject({
      id: briefId,
      ownerSubject: owner,
      postDraftId: post.id,
      postVersion: post.version,
      brandProfileVersion: 1,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode: "EDITORIAL_STATEMENT",
      coverHook: "Clarity beats capability.",
      conceptSummary: "Restrained editorial geometry about choosing clarity",
      topicLabel: "POSITIONING",
      state: "ready"
    });
    expect(result.profile).toMatchObject({
      version: 1,
      publicName: "BHAGYASHREE NANDOSKAR",
      roleLine: "PRODUCT MARKETING",
      seriesName: "PMM FIELD NOTES",
      monogram: "BN"
    });
    expect(result.profile.recentUsage).toEqual([{
      templateId: "editorial-statement-v1",
      coverHook: "Clarity beats capability.",
      createdAt: result.brief.createdAt
    }]);
    expect(result.requiresSourceImage).toBe(false);
    expect(result.proposedAltText).toBe(
      "Editorial PMM Field Notes cover reading “Clarity beats capability.”."
    );
    expect([...result.proposedAltText].length).toBeLessThanOrEqual(120);
    expect(result.brief.generationPrompt).toContain("restrained abstract geometry");
    expect(result.brief.generationPrompt).not.toContain(result.brief.coverHook);
    expect(result.brief.generationPrompt).not.toContain("BHAGYASHREE");
    expect(result.brief.negativeConstraintsJson).toContain("readable text");

    const profiles = await queryTestDatabase<{
      version: number;
      public_name: string;
      role_line: string;
      series_name: string;
      monogram: string;
    }>(db, `
      select version, public_name, role_line, series_name, monogram
      from career_mcp.brand_profiles
      where owner_subject = '${owner}'
    `);
    expect(profiles).toEqual([{
      version: 1,
      public_name: "BHAGYASHREE NANDOSKAR",
      role_line: "PRODUCT MARKETING",
      series_name: "PMM FIELD NOTES",
      monogram: "BN"
    }]);
  });

  it("does not leave a first profile behind when first brief creation fails", async () => {
    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    const generatedIds = [randomUUID(), "invalid-brief-id"];
    const service = createBrandBriefService(db, {
      subject: owner,
      createId: () => generatedIds.shift()!
    });

    const error = await expectDomainError(
      () => service.createBrief(statementInput(post.draftId, post.version)),
      "DATA_INTEGRITY"
    );

    expect(error).toMatchObject({
      message: "Brand visual brief could not be saved",
      details: { entity: "brand_visual_brief" }
    });
    expect(await db.brandProfiles.getActive(owner)).toBeUndefined();
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toEqual([]);
  });

  it("selects the metaphor template and returns its source-image requirement", async () => {
    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    const service = createBrandBriefService(db, { subject: owner });

    const result = await service.createBrief(statementInput(post.draftId, post.version, {
      coverHook: "Positioning creates useful tension.",
      conceptSummary: "Two tactile shapes held in deliberate visual tension",
      visualMode: "EDITORIAL_METAPHOR",
      topicLabel: "  creative   strategy "
    }));

    expect(result.brief).toMatchObject({
      templateId: "editorial-metaphor-v1",
      templateVersion: 1,
      visualMode: "EDITORIAL_METAPHOR",
      topicLabel: "CREATIVE STRATEGY"
    });
    expect(result.requiresSourceImage).toBe(true);
    expect(result.brief.generationPrompt).toContain("abstract metaphor");
    expect(result.brief.generationPrompt).toContain("right-side template image zone");
    expect(result.brief.generationPrompt).not.toContain(result.brief.coverHook);
  });

  it("rejects stale expected versions with the established safe conflict", async () => {
    const owner = randomUUID();
    const media = await addMedia(owner);
    const first = await addOwnedPost(owner, { mediaId: media.id });
    const second = await addOwnedPost(owner, {
      draftId: first.draftId,
      expectedVersion: first.version,
      text: "The latest private post version.",
      mediaId: media.id
    });
    const service = createBrandBriefService(db, { subject: owner });

    const error = await expectDomainError(
      () => service.createBrief(statementInput(first.draftId, first.version)),
      "CONFLICT"
    );

    expect(error).toMatchObject({
      message: "Post draft version is stale",
      details: {
        entity: "post_draft",
        expectedVersion: first.version,
        actualVersion: second.version
      }
    });
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toEqual([]);
    expect(await db.brandProfiles.getActive(owner)).toBeUndefined();
  });

  it("makes absent and cross-owner post versions indistinguishable before any write", async () => {
    const owner = randomUUID();
    const foreignOwner = randomUUID();
    const foreignPost = await addOwnedPost(foreignOwner);
    const service = createBrandBriefService(db, { subject: owner });
    const absentId = randomUUID();

    const foreign = await expectDomainError(
      () => service.createBrief(statementInput(foreignPost.draftId, foreignPost.version)),
      "NOT_FOUND"
    );
    const absent = await expectDomainError(
      () => service.createBrief(statementInput(absentId, 1)),
      "NOT_FOUND"
    );

    expect({
      code: foreign.code,
      message: foreign.message,
      details: foreign.details
    }).toEqual({
      code: absent.code,
      message: absent.message,
      details: absent.details
    });
    expect(foreign).toMatchObject({
      message: "Post draft was not found",
      details: { entity: "post_draft" }
    });
    expect(await db.brandProfiles.getActive(owner)).toBeUndefined();
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toEqual([]);
  });

  it("rejects exact normalized hook reuse within the owner's last thirty briefs", async () => {
    const owner = randomUUID();
    const firstPost = await addOwnedPost(owner);
    const secondPost = await addOwnedPost(owner);
    const service = createBrandBriefService(db, { subject: owner });
    await service.createBrief(statementInput(firstPost.draftId, firstPost.version, {
      coverHook: "Clarity beats capability."
    }));

    const error = await expectDomainError(
      () => service.createBrief(statementInput(secondPost.draftId, secondPost.version, {
        coverHook: "  Clarity   beats capability.  "
      })),
      "VALIDATION_ERROR"
    );

    expect(error).toMatchObject({
      message: "Cover hook does not meet the brand rules.",
      details: { field: "coverHook", reason: "recent_duplicate" }
    });
    expect(await db.brandVisualBriefs.listRecent(owner, 30)).toHaveLength(1);
  });

  it("returns only bounded review-card provenance for owner-scoped rendered media", async () => {
    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    const service = createBrandBriefService(db, { subject: owner });
    const { brief } = await service.createBrief(statementInput(post.draftId, post.version));
    const renderedMedia = await addMedia(owner);
    const checksum = renderedMedia.sha256;
    const mismatchedMedia = await addMedia(owner);
    const mismatchedChecksum = mismatchedMedia.sha256 === "b".repeat(64)
      ? "c".repeat(64)
      : "b".repeat(64);
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, rendered_media_id, alt_text,
        render_checksum, renderer_version, created_at
      ) values (
        '${randomUUID()}', '${owner}', '${brief.id}', 1, '${renderedMedia.id}',
        'Reviewed editorial cover', '${checksum}', 1, '2026-07-22T10:00:00.000Z'
      )
    `);
    await queryTestDatabase(db, `
      insert into career_mcp.brand_visual_renders (
        id, owner_subject, brief_id, version, rendered_media_id, alt_text,
        render_checksum, renderer_version, created_at
      ) values (
        '${randomUUID()}', '${owner}', '${brief.id}', 2, '${mismatchedMedia.id}',
        'Mismatched editorial cover', '${mismatchedChecksum}', 1,
        '2026-07-22T10:01:00.000Z'
      )
    `);

    expect(await service.getProvenanceForMedia(renderedMedia.id)).toEqual({
      seriesName: "PMM FIELD NOTES",
      profileVersion: 1,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      coverHook: "Clarity beats capability.",
      renderChecksum: checksum,
      validationPassed: true
    });
    expect(await service.getProvenanceForMedia(mismatchedMedia.id)).toMatchObject({
      renderChecksum: mismatchedChecksum,
      validationPassed: false
    });
    expect(
      await createBrandBriefService(db, { subject: randomUUID() })
        .getProvenanceForMedia(renderedMedia.id)
    ).toBeUndefined();
    expect(await service.getProvenanceForMedia(randomUUID())).toBeUndefined();
  });

  it("preserves safe domain errors raised while loading render provenance", async () => {
    const owner = randomUUID();
    const expected = new DomainError(
      "DATA_INTEGRITY",
      "Stored brand render provenance is invalid",
      { entity: "brand_visual_render" }
    );
    const brokenDatabase = {
      ...db,
      brandVisualRenders: {
        ...db.brandVisualRenders,
        async getByRenderedMedia() {
          throw expected;
        }
      }
    };
    const service = createBrandBriefService(brokenDatabase, { subject: owner });

    await expect(service.getProvenanceForMedia(randomUUID())).rejects.toBe(expected);
  });

  it("requires an authenticated owner and validates the bounded optional topic label", async () => {
    expect(() => createBrandBriefService(db, { subject: "not-a-subject" })).toThrowError(
      expect.objectContaining({
        code: "AUTH_REQUIRED",
        message: "Authenticated request identity is required"
      })
    );

    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    const service = createBrandBriefService(db, { subject: owner });
    const error = await expectDomainError(
      () => service.createBrief(statementInput(post.draftId, post.version, {
        topicLabel: "x".repeat(25)
      })),
      "VALIDATION_ERROR"
    );
    expect(error).toMatchObject({
      message: "Brand brief input is invalid",
      details: { field: "topicLabel", reason: "character_count", maximum: 24 }
    });
    expect(await db.brandProfiles.getActive(owner)).toBeUndefined();
  });

  it("maps unexpected persistence failures to model-safe errors", async () => {
    const owner = randomUUID();
    const post = await addOwnedPost(owner);
    const brokenDatabase = {
      ...db,
      postDrafts: {
        ...db.postDrafts,
        async getVersion() {
          throw new Error("private-provider-detail");
        }
      }
    };
    const service = createBrandBriefService(brokenDatabase, { subject: owner });

    const error = await expectDomainError(
      () => service.createBrief(statementInput(post.draftId, post.version)),
      "DATA_INTEGRITY"
    );

    expect(error.message).toBe("Brand visual brief could not be saved");
    expect(JSON.stringify(error)).not.toContain("private");
    expect(error.details).toEqual({ entity: "brand_visual_brief" });
  });
});
