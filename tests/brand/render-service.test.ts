import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrandRenderService
} from "../../src/brand/render-service.js";
import { DEFAULT_PMM_BRAND_PROFILE } from "../../src/brand/profile.js";
import type {
  RenderBrandedCoverInput,
  RenderedBrandCover
} from "../../src/brand/renderer.js";
import type { CareerDatabase } from "../../src/db/client.js";
import type { PostMedia } from "../../src/db/repositories.js";
import { DomainError } from "../../src/domain/errors.js";
import type { OpenAiFileRef } from "../../src/media/file-download.js";
import type { ImageInspection } from "../../src/media/image-inspection.js";
import { createPrivateMediaStore } from "../../src/media/private-media-store.js";
import { checksumLinkedInPost } from "../../src/posts/post-checksum.js";
import {
  createTestDatabase,
  queryTestDatabase,
  type TestCareerDatabase
} from "../support/database.js";

let db: TestCareerDatabase;

const owner = "123e4567-e89b-42d3-a456-426614174000";
const otherOwner = "223e4567-e89b-42d3-a456-426614174000";
const sourceBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const finalBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
const sourceFile: OpenAiFileRef = Object.freeze({
  download_url: "https://files.openai.example/brand-source",
  file_id: "file-brand-source",
  mime_type: "image/png",
  file_name: "source.png"
});
const altText = "PMM Field Notes cover reading “Clarity beats capability.”";

const upload = vi.fn<(
  path: string,
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png" | "image/gif"
) => Promise<void>>(async () => undefined);
const remove = vi.fn<(paths: readonly string[]) => Promise<void>>(async () => undefined);
const downloadFile = vi.fn<(file: OpenAiFileRef) => Promise<Uint8Array>>(
  async () => Buffer.from(sourceBytes)
);
const inspectImage = vi.fn<(
  bytes: Uint8Array,
  declaredMimeType?: string
) => Promise<ImageInspection>>(async (bytes, declaredMimeType) => {
  if (declaredMimeType !== undefined && declaredMimeType !== "image/png") {
    throw new DomainError("MEDIA_VALIDATION_ERROR", "Draft image validation failed");
  }
  const snapshot = Buffer.from(bytes);
  const isFinal = snapshot.equals(finalBytes);
  return {
    mimeType: "image/png",
    width: isFinal ? 1080 : 1200,
    height: isFinal ? 1350 : 627,
    frameCount: 1,
    byteSize: snapshot.byteLength,
    sha256: createHash("sha256").update(snapshot).digest("hex")
  };
});
const storage = {
  upload,
  download: vi.fn(),
  createSignedUrl: vi.fn(),
  remove
};

function canonicalProfile(ownerSubject: string) {
  return {
    id: randomUUID(),
    ownerSubject,
    publicName: DEFAULT_PMM_BRAND_PROFILE.publicName,
    roleLine: DEFAULT_PMM_BRAND_PROFILE.roleLine,
    seriesName: DEFAULT_PMM_BRAND_PROFILE.seriesName,
    monogram: DEFAULT_PMM_BRAND_PROFILE.monogram,
    voiceJson: {
      persona: DEFAULT_PMM_BRAND_PROFILE.voice.persona,
      traits: [...DEFAULT_PMM_BRAND_PROFILE.voice.traits],
      neverInventExperience: true
    },
    paletteJson: { ...DEFAULT_PMM_BRAND_PROFILE.palette },
    hookRulesJson: { ...DEFAULT_PMM_BRAND_PROFILE.hookRules }
  };
}

async function addMedia(
  ownerSubject: string,
  options: {
    bytes?: Buffer;
    id?: string;
    originalFilename?: string;
    width?: number;
    height?: number;
  } = {}
): Promise<PostMedia> {
  const id = options.id ?? randomUUID();
  const bytes = options.bytes ?? Buffer.from(randomUUID());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return await db.postMedia.create({
    id,
    ownerSubject,
    objectPath: `${ownerSubject}/${sha256.slice(0, 2)}/${id}.png`,
    sha256,
    mimeType: "image/png",
    byteSize: bytes.byteLength,
    width: options.width ?? 1200,
    height: options.height ?? 627,
    frameCount: 1,
    ...(options.originalFilename === undefined
      ? {}
      : { originalFilename: options.originalFilename })
  });
}

async function readyBrief(
  ownerSubject = owner,
  visualMode: "EDITORIAL_STATEMENT" | "EDITORIAL_METAPHOR" = "EDITORIAL_STATEMENT"
) {
  const postMedia = await addMedia(ownerSubject);
  const post = (await db.postDrafts.createVersionWithMedia({
    ownerSubject,
    text: "Positioning improves when teams choose one clear audience.",
    visibility: "PUBLIC",
    checksum: "brand-render-source",
    state: "draft",
    media: [{ mediaId: postMedia.id, altText: "Private draft ownership media" }]
  })).post;
  const templateId = visualMode === "EDITORIAL_STATEMENT"
    ? "editorial-statement-v1"
    : "editorial-metaphor-v1";
  const result = await db.brandVisualBriefs.createWithDefaultProfile({
    profile: canonicalProfile(ownerSubject),
    brief: {
      id: randomUUID(),
      ownerSubject,
      postDraftId: post.id,
      postVersion: post.version,
      templateId,
      templateVersion: 1,
      promptFormatVersion: 1,
      visualMode,
      coverHook: "Clarity beats capability.",
      conceptSummary: "Restrained editorial geometry",
      topicLabel: "POSITIONING",
      generationPrompt: "A text-free editorial illustration",
      negativeConstraintsJson: ["no text"],
      state: "ready"
    }
  });
  return { post, profile: result.profile, brief: result.brief };
}

function renderedCover(bytes = finalBytes): RenderedBrandCover {
  return Object.freeze({
    bytes: Buffer.from(bytes),
    mimeType: "image/png",
    width: 1080,
    height: 1350,
    validation: Object.freeze({
      fixedLabelsPresent: true,
      textWithinSafeArea: true,
      sourceImageUsed: false
    })
  });
}

function privateStore(
  ownerSubject = owner,
  ids: readonly string[] = [],
  database: CareerDatabase = db
) {
  const remainingIds = [...ids];
  return createPrivateMediaStore(database, {
    subject: ownerSubject,
    storage,
    downloadFile,
    inspectImage,
    createId: () => remainingIds.shift() ?? randomUUID()
  });
}

function renderService(options: {
  database?: CareerDatabase;
  ownerSubject?: string;
  ids?: readonly string[];
  renderCover?: (input: RenderBrandedCoverInput) => Promise<RenderedBrandCover>;
} = {}) {
  const ownerSubject = options.ownerSubject ?? owner;
  const database = options.database ?? db;
  return createBrandRenderService(database, {
    subject: ownerSubject,
    privateMedia: privateStore(ownerSubject, options.ids, database),
    renderCover: options.renderCover ?? vi.fn(async () => renderedCover())
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
    expect(error).toMatchObject({ code });
    return error as DomainError;
  }
  throw new Error("Expected a DomainError");
}

beforeAll(async () => {
  db = await createTestDatabase();
});
beforeEach(() => {
  upload.mockReset();
  upload.mockResolvedValue(undefined);
  remove.mockReset();
  remove.mockResolvedValue(undefined);
  downloadFile.mockClear();
  inspectImage.mockClear();
});
afterEach(async () => {
  await db.resetForTests();
});
afterAll(async () => {
  await db?.close();
});

describe("brand render service", () => {
  it("branded render stores and attaches exactly one final statement cover", async () => {
    const source = await readyBrief();
    const renderCover = vi.fn(async () => renderedCover());

    const result = await renderService({ renderCover }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      altText
    });

    expect(result.post.version).toBe(source.post.version + 1);
    expect(result.post.media).toHaveLength(1);
    expect(result.post.media[0]).toMatchObject({
      position: 0,
      altText,
      mimeType: "image/png",
      width: 1080,
      height: 1350,
      originalFilename: "brand-cover.png"
    });
    expect(result.post.checksum).toBe(checksumLinkedInPost({
      draftId: result.post.id,
      version: result.post.version,
      text: result.post.text,
      visibility: result.post.visibility,
      media: result.post.media
    }));
    expect(result.provenance).toEqual({
      seriesName: "PMM FIELD NOTES",
      profileVersion: 1,
      templateId: "editorial-statement-v1",
      templateVersion: 1,
      coverHook: "Clarity beats capability.",
      renderChecksum: createHash("sha256").update(finalBytes).digest("hex"),
      validationPassed: true,
      validation: {
        fixedLabelsPresent: true,
        textWithinSafeArea: true,
        sourceImageUsed: false
      }
    });
    expect(renderCover).toHaveBeenCalledWith({
      profile: DEFAULT_PMM_BRAND_PROFILE,
      template: expect.objectContaining({ id: "editorial-statement-v1" }),
      coverHook: "Clarity beats capability.",
      topicLabel: "POSITIONING"
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count from career_mcp.post_previews
    `)).toEqual([{ count: 0 }]);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count from career_mcp.publish_attempts
    `)).toEqual([{ count: 0 }]);
  });

  it("branded render ingests one metaphor source but keeps it private and unattached", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const renderCover = vi.fn(async () => Object.freeze({
      ...renderedCover(),
      validation: Object.freeze({
        fixedLabelsPresent: true,
        textWithinSafeArea: true,
        sourceImageUsed: true
      })
    }));

    const result = await renderService({ renderCover }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    });

    const renders = await queryTestDatabase<{
      source_media_id: string;
      rendered_media_id: string;
    }>(db, `
      select source_media_id, rendered_media_id
      from career_mcp.brand_visual_renders
      where brief_id = '${source.brief.id}'
    `);
    expect(renders).toHaveLength(1);
    expect(renders[0]?.source_media_id).not.toBe(renders[0]?.rendered_media_id);
    expect(result.post.media.map(({ mediaId }) => mediaId))
      .toEqual([renders[0]?.rendered_media_id]);
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.post_draft_media
      where media_id = '${renders[0]?.source_media_id}'
    `)).toEqual([{ count: 0 }]);
    expect(renderCover).toHaveBeenCalledWith(expect.objectContaining({
      template: expect.objectContaining({ id: "editorial-metaphor-v1" }),
      sourceImageBytes: sourceBytes
    }));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("branded render rejects a supplied statement source before ingestion or rendering", async () => {
    const source = await readyBrief();
    const renderCover = vi.fn(async () => renderedCover());

    await expectDomainError(() => renderService({ renderCover }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    }), "VALIDATION_ERROR");

    expect(downloadFile).not.toHaveBeenCalled();
    expect(renderCover).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("branded render requires a metaphor source before ingestion or rendering", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const renderCover = vi.fn(async () => renderedCover());

    await expectDomainError(() => renderService({ renderCover }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      altText
    }), "VALIDATION_ERROR");

    expect(downloadFile).not.toHaveBeenCalled();
    expect(renderCover).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("branded render hides a foreign brief and performs no media side effect", async () => {
    const source = await readyBrief(otherOwner);
    const renderCover = vi.fn(async () => renderedCover());

    await expect(renderService({ renderCover }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      altText
    })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Brand visual brief was not found",
      details: { entity: "brand_visual_brief" }
    });

    expect(renderCover).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("branded render rejects a stale source before download, render, or storage mutation", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const sourceMedia = await db.postDraftMedia.listForVersion(
      source.post.id,
      source.post.version
    );
    const latest = (await db.postDrafts.createVersionWithMedia({
      draftId: source.post.draftId,
      expectedVersion: source.post.version,
      ownerSubject: owner,
      text: "Newer exact post version",
      visibility: "PUBLIC",
      state: "draft",
      media: sourceMedia.map(({ mediaId, altText: currentAltText }) => ({
        mediaId,
        altText: currentAltText
      })),
      checksum: "newer-version"
    })).post;
    const renderCover = vi.fn(async () => renderedCover());

    await expect(renderService({ renderCover }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Post draft version is stale",
      details: {
        entity: "post_draft",
        expectedVersion: source.post.version,
        actualVersion: latest.version
      }
    });

    expect(downloadFile).not.toHaveBeenCalled();
    expect(renderCover).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("branded render accepts only ready briefs", async () => {
    const source = await readyBrief();
    await queryTestDatabase(db, `
      update career_mcp.brand_visual_briefs
      set state = 'rendered'
      where id = '${source.brief.id}'
    `);
    const renderCover = vi.fn(async () => renderedCover());

    await expectDomainError(() => renderService({ renderCover }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      altText
    }), "CONFLICT");

    expect(renderCover).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    ["briefId", { briefId: "not-a-uuid" }],
    ["postId", { postId: "not-a-uuid" }],
    ["expectedVersion", { expectedVersion: 0 }],
    ["empty alt text", { altText: "" }],
    ["multiline alt text", { altText: "line one\nline two" }],
    ["overlong alt text", { altText: "a".repeat(121) }]
  ])("branded render validates %s before loading or storing", async (_label, override) => {
    const input = {
      briefId: randomUUID(),
      postId: randomUUID(),
      expectedVersion: 1,
      altText,
      ...override
    };

    await expectDomainError(() => renderService().render(input), "VALIDATION_ERROR");

    expect(downloadFile).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("branded render removes a new source and provisional final object when final storage fails", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const sourceId = randomUUID();
    const finalId = randomUUID();
    const storageError = new DomainError(
      "MEDIA_STORAGE_ERROR",
      "Draft media storage operation failed"
    );
    upload.mockImplementation(async (path) => {
      if (path.includes(finalId)) throw storageError;
    });

    await expect(renderService({
      ids: [sourceId, finalId],
      renderCover: vi.fn(async () => Object.freeze({
        ...renderedCover(),
        validation: Object.freeze({
          fixedLabelsPresent: true,
          textWithinSafeArea: true,
          sourceImageUsed: true
        })
      }))
    }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    })).rejects.toBe(storageError);

    expect(remove.mock.calls.flatMap(([paths]) => paths)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(sourceId),
        expect.stringContaining(finalId)
      ])
    );
    expect(await db.postMedia.get(sourceId)).toBeUndefined();
    expect(await db.postMedia.get(finalId)).toBeUndefined();
    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({ state: "ready" });
  });

  it("branded render removes a newly ingested source when rendering fails and preserves the safe error", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const sourceId = randomUUID();
    const renderError = new DomainError(
      "MEDIA_VALIDATION_ERROR",
      "Brand source image validation failed",
      { field: "sourceImageBytes", reason: "decode" }
    );

    await expect(renderService({
      ids: [sourceId],
      renderCover: vi.fn(async () => {
        throw renderError;
      })
    }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    })).rejects.toBe(renderError);

    expect(await db.postMedia.get(sourceId)).toBeUndefined();
    expect(remove.mock.calls.flatMap(([paths]) => paths))
      .toEqual([expect.stringContaining(sourceId)]);
    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({ state: "ready" });
  });

  it("branded render removes both new unreferenced media after an unknown database failure and maps it safely", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const sourceId = randomUUID();
    const finalId = randomUUID();
    const failingDatabase = {
      ...db,
      brandVisualRenders: {
        ...db.brandVisualRenders,
        commitAndAttach: vi.fn(async () => {
          throw new Error("postgres://admin:secret@db.example/internal");
        })
      }
    } as CareerDatabase;

    const error = await expectDomainError(() => renderService({
      database: failingDatabase,
      ids: [sourceId, finalId],
      renderCover: vi.fn(async () => Object.freeze({
        ...renderedCover(),
        validation: Object.freeze({
          fixedLabelsPresent: true,
          textWithinSafeArea: true,
          sourceImageUsed: true
        })
      }))
    }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    }), "DATA_INTEGRITY");

    expect(error.message).toBe("Brand cover could not be saved");
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(await db.postMedia.get(sourceId)).toBeUndefined();
    expect(await db.postMedia.get(finalId)).toBeUndefined();
    expect(remove.mock.calls.flatMap(([paths]) => paths)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(sourceId),
        expect.stringContaining(finalId)
      ])
    );
  });

  it("branded render preserves deduped source and final media after database failure", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const existingSource = await addMedia(owner, {
      bytes: sourceBytes,
      width: 1200,
      height: 627
    });
    const existingFinal = await addMedia(owner, {
      bytes: finalBytes,
      width: 1080,
      height: 1350,
      originalFilename: "existing-cover.png"
    });
    const failure = new DomainError("CONFLICT", "Brand cover conflicts", {
      entity: "brand_visual_render"
    });
    const failingDatabase = {
      ...db,
      brandVisualRenders: {
        ...db.brandVisualRenders,
        commitAndAttach: vi.fn(async () => {
          throw failure;
        })
      }
    } as CareerDatabase;

    await expect(renderService({
      database: failingDatabase,
      renderCover: vi.fn(async () => Object.freeze({
        ...renderedCover(),
        validation: Object.freeze({
          fixedLabelsPresent: true,
          textWithinSafeArea: true,
          sourceImageUsed: true
        })
      }))
    }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    })).rejects.toBe(failure);

    expect(await db.postMedia.get(existingSource.id)).toEqual(existingSource);
    expect(await db.postMedia.get(existingFinal.id)).toEqual(existingFinal);
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("branded render preserves committed source and final media after an ambiguous commit response", async () => {
    const source = await readyBrief(owner, "EDITORIAL_METAPHOR");
    const sourceId = randomUUID();
    const finalId = randomUUID();
    const commitAndAttach = db.brandVisualRenders.commitAndAttach;
    const deleteOwnedUnreferenced = db.postMedia.deleteOwnedUnreferenced;
    const cleanupResults: string[][] = [];
    const ambiguousDatabase = {
      ...db,
      brandVisualRenders: {
        ...db.brandVisualRenders,
        commitAndAttach: vi.fn(async (
          ...args: Parameters<typeof commitAndAttach>
        ) => {
          await commitAndAttach(...args);
          throw new Error("simulated ambiguous database response");
        })
      },
      postMedia: {
        ...db.postMedia,
        deleteOwnedUnreferenced: vi.fn(async (
          ...args: Parameters<typeof deleteOwnedUnreferenced>
        ) => {
          const result = await deleteOwnedUnreferenced(...args);
          cleanupResults.push(result);
          return result;
        })
      }
    } as CareerDatabase;

    await expect(renderService({
      database: ambiguousDatabase,
      ids: [sourceId, finalId],
      renderCover: vi.fn(async () => Object.freeze({
        ...renderedCover(),
        validation: Object.freeze({
          fixedLabelsPresent: true,
          textWithinSafeArea: true,
          sourceImageUsed: true
        })
      }))
    }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      sourceImage: sourceFile,
      altText
    })).rejects.toMatchObject({
      code: "DATA_INTEGRITY",
      message: "Brand cover could not be saved"
    });

    expect(await db.postDrafts.listVersions(source.post.draftId)).toHaveLength(2);
    expect(await db.brandVisualBriefs.getOwned(source.brief.id, owner))
      .toMatchObject({ state: "rendered" });
    expect(await queryTestDatabase<{ count: number }>(db, `
      select count(*)::int as count
      from career_mcp.brand_visual_renders
      where brief_id = '${source.brief.id}'
        and source_media_id = '${sourceId}'
        and rendered_media_id = '${finalId}'
    `)).toEqual([{ count: 1 }]);
    expect(await db.postMedia.get(sourceId)).toBeDefined();
    expect(await db.postMedia.get(finalId)).toBeDefined();
    expect(cleanupResults).toEqual([[]]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("branded render preserves the original safe error when best-effort cleanup fails", async () => {
    const source = await readyBrief();
    const finalId = randomUUID();
    const original = new DomainError("CONFLICT", "Brand cover conflicts", {
      entity: "brand_visual_render"
    });
    const failingDatabase = {
      ...db,
      brandVisualRenders: {
        ...db.brandVisualRenders,
        commitAndAttach: vi.fn(async () => {
          throw original;
        })
      },
      postMedia: {
        ...db.postMedia,
        deleteOwnedUnreferenced: vi.fn(async () => {
          throw new Error("cleanup database unavailable");
        })
      }
    } as CareerDatabase;

    await expect(renderService({
      database: failingDatabase,
      ids: [finalId]
    }).render({
      briefId: source.brief.id,
      postId: source.post.draftId,
      expectedVersion: source.post.version,
      altText
    })).rejects.toBe(original);

    expect(remove).not.toHaveBeenCalled();
  });
});
