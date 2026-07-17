import type { CareerDatabase } from "../db/client.js";
import type { PostVisibility } from "../drafts/service.js";
import { DomainError } from "../domain/errors.js";
import type { PreviewExpected, PreviewService } from "../posts/preview-service.js";

const POST_VISIBILITIES: ReadonlySet<string> = new Set(["PUBLIC", "CONNECTIONS"]);

export type PublishInput = PreviewExpected & { previewToken: string };

export type LinkedInPostsClient = {
  /**
   * A transport boundary only. Task 7 supplies fakes; the real Posts API
   * adapter is deliberately introduced in the next task.
   */
  createTextPost(input: { text: string; visibility: PostVisibility }): Promise<unknown>;
};

export type PublishResult =
  | { state: "published"; postUrn: string }
  | { state: "publish_failed" }
  | { state: "publish_unknown" };

export type PublishServiceDependencies = {
  previewService: PreviewService;
  client: LinkedInPostsClient;
  publishEnabled: boolean;
  clock?: () => Date;
};

type Completion = {
  result: PublishResult;
  responseCategory: "published" | "definite_rejection" | "ambiguous";
  nextState: "published" | "publish_failed" | "publish_unknown";
  postUrn?: string;
  sanitizedError?: string;
};

function nowIso(clock: () => Date): string {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError("DATA_INTEGRITY", "Publish clock returned an invalid value", {
      entity: "publish_attempt"
    });
  }
  return new Date(now.getTime()).toISOString();
}

function validationError(): DomainError {
  return new DomainError("VALIDATION_ERROR", "Publish input is invalid", { field: "publish" });
}

function parseInput(value: unknown): PublishInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError();
  }
  const input = value as Record<string, unknown>;
  const expectedFields = [
    "postId",
    "versionId",
    "version",
    "checksum",
    "visibility",
    "previewToken"
  ];
  const fields = Object.keys(input);
  if (fields.length !== expectedFields.length || fields.some((field) => !expectedFields.includes(field))) {
    throw validationError();
  }
  if (
    typeof input.postId !== "string"
    || typeof input.versionId !== "string"
    || typeof input.version !== "number"
    || !Number.isSafeInteger(input.version)
    || typeof input.checksum !== "string"
    || typeof input.visibility !== "string"
    || !POST_VISIBILITIES.has(input.visibility)
    || typeof input.previewToken !== "string"
  ) {
    throw validationError();
  }
  return {
    postId: input.postId,
    versionId: input.versionId,
    version: input.version,
    checksum: input.checksum,
    visibility: input.visibility as PostVisibility,
    previewToken: input.previewToken
  };
}

function validPostUrn(value: unknown): value is string {
  return typeof value === "string" && /^urn:li:(?:share|ugcPost):[0-9]+$/.test(value);
}

function responseStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return undefined;
  }
  const status = (value as { status?: unknown }).status;
  return typeof status === "number"
    && Number.isSafeInteger(status)
    && status >= 100
    && status <= 599
    ? status
    : undefined;
}

function completionForResponse(response: unknown): Completion {
  const status = responseStatus(response);
  const postUrn = typeof response === "object" && response !== null && "postUrn" in response
    ? (response as { postUrn?: unknown }).postUrn
    : undefined;
  if (status !== undefined && status >= 200 && status < 300 && validPostUrn(postUrn)) {
    return {
      result: { state: "published", postUrn },
      responseCategory: "published",
      nextState: "published",
      postUrn
    };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return {
      result: { state: "publish_failed" },
      responseCategory: "definite_rejection",
      nextState: "publish_failed",
      sanitizedError: "LinkedIn rejected this post"
    };
  }
  return {
    result: { state: "publish_unknown" },
    responseCategory: "ambiguous",
    nextState: "publish_unknown",
    sanitizedError: "LinkedIn publish result is unknown"
  };
}

function completionForThrownResponse(error: unknown): Completion {
  const status = responseStatus(error);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return {
      result: { state: "publish_failed" },
      responseCategory: "definite_rejection",
      nextState: "publish_failed",
      sanitizedError: "LinkedIn rejected this post"
    };
  }
  return {
    result: { state: "publish_unknown" },
    responseCategory: "ambiguous",
    nextState: "publish_unknown",
    sanitizedError: "LinkedIn publish result is unknown"
  };
}

/**
 * This service deliberately has one and only one `createTextPost` await.
 * An ambiguous result is terminal for the saved version to avoid duplicates.
 */
export function createPublishService(database: CareerDatabase, dependencies: PublishServiceDependencies) {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async publish(inputValue: PublishInput): Promise<PublishResult> {
      if (!dependencies.publishEnabled) {
        throw new DomainError("PUBLISH_DISABLED", "LinkedIn publishing is disabled");
      }
      const input = parseInput(inputValue);
      const claim = await dependencies.previewService.consumeForPublish(input.previewToken, {
        postId: input.postId,
        versionId: input.versionId,
        version: input.version,
        checksum: input.checksum,
        visibility: input.visibility
      }, nowIso(clock));

      let completion: Completion;
      try {
        completion = completionForResponse(await dependencies.client.createTextPost({
          text: claim.text,
          visibility: claim.visibility
        }));
      } catch (error) {
        completion = completionForThrownResponse(error);
      }

      try {
        const updatedAttempt = await database.publishAttempts.updateResult(claim.attemptId, {
          responseCategory: completion.responseCategory,
          ...(completion.postUrn === undefined ? {} : { postUrn: completion.postUrn }),
          ...(completion.sanitizedError === undefined
            ? {}
            : { sanitizedError: completion.sanitizedError }),
          completedAt: nowIso(clock)
        });
        if (updatedAttempt === undefined) {
          return { state: "publish_unknown" };
        }
        const updatedPost = await database.postDrafts.transitionState({
          versionId: claim.versionId,
          version: claim.version,
          expectedState: "publishing",
          nextState: completion.nextState
        });
        if (updatedPost === undefined) {
          return { state: "publish_unknown" };
        }
      } catch {
        // The external request may have succeeded; never report a retryable failure.
        return { state: "publish_unknown" };
      }
      return completion.result;
    }
  };
}

export type PublishService = ReturnType<typeof createPublishService>;
