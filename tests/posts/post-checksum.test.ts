import { describe, expect, it } from "vitest";
import {
  POST_CHECKSUM_CONTRACT,
  checksumLinkedInPost
} from "../../src/posts/post-checksum.js";

const vector = {
  draftId: "123e4567-e89b-12d3-a456-426614174000",
  version: 2,
  text: "Hello, PMM 👋",
  visibility: "CONNECTIONS" as const,
  media: [
    { position: 0, sha256: "a".repeat(64), mimeType: "image/png" as const, altText: "Chart" },
    { position: 1, sha256: "b".repeat(64), mimeType: "image/jpeg" as const, altText: "Team" }
  ]
};

describe("checksumLinkedInPost", () => {
  it("matches the independently specified v2 fixed vector", () => {
    expect(POST_CHECKSUM_CONTRACT).toBe("pmm-career-mcp.linkedin-post.sha256.v2");
    expect(checksumLinkedInPost(vector)).toBe(
      "56562ef828e0cebcbddd3199308862f08ed76afdf351476e41714ab6dba44261"
    );
  });

  it("binds every exact post and ordered-media field", () => {
    const checksum = checksumLinkedInPost(vector);
    const mutations = [
      () => checksumLinkedInPost(vector, "pmm-career-mcp.linkedin-post.sha256.v3"),
      () => checksumLinkedInPost({ ...vector, draftId: "223e4567-e89b-12d3-a456-426614174000" }),
      () => checksumLinkedInPost({ ...vector, version: 3 }),
      () => checksumLinkedInPost({ ...vector, text: "Hello, PMM 👋!" }),
      () => checksumLinkedInPost({ ...vector, text: "Hello, PMM 👋\0" }),
      () => checksumLinkedInPost({ ...vector, visibility: "PUBLIC" as const }),
      () => checksumLinkedInPost({ ...vector, media: vector.media.slice(0, 1) }),
      () => checksumLinkedInPost({
        ...vector,
        media: [{ ...vector.media[0]!, position: 1 }, vector.media[1]!]
      }),
      () => checksumLinkedInPost({
        ...vector,
        media: [{ ...vector.media[0]!, sha256: "c".repeat(64) }, vector.media[1]!]
      }),
      () => checksumLinkedInPost({
        ...vector,
        media: [{ ...vector.media[0]!, mimeType: "image/gif" as const }, vector.media[1]!]
      }),
      () => checksumLinkedInPost({
        ...vector,
        media: [{ ...vector.media[0]!, altText: "Chart!" }, vector.media[1]!]
      })
    ];

    for (const mutation of mutations) {
      expect(mutation()).not.toBe(checksum);
    }
  });

  it("uses UTF-8 byte lengths and is deterministic across property insertion order", () => {
    const reordered = {
      media: vector.media.map(({ altText, mimeType, position, sha256 }) => ({
        altText,
        sha256,
        position,
        mimeType
      })),
      visibility: vector.visibility,
      text: vector.text,
      version: vector.version,
      draftId: vector.draftId
    };
    expect(checksumLinkedInPost(reordered)).toBe(checksumLinkedInPost(vector));
    expect(checksumLinkedInPost({ ...vector, text: "é" })).not.toBe(
      checksumLinkedInPost({ ...vector, text: "e" })
    );
  });

  it("rejects malformed versions, positions, SHA values, and oversized length metadata", () => {
    expect(() => checksumLinkedInPost({ ...vector, version: 0 })).toThrow();
    expect(() => checksumLinkedInPost({
      ...vector,
      media: [{ ...vector.media[0]!, position: -1 }]
    })).toThrow();
    expect(() => checksumLinkedInPost({
      ...vector,
      media: [{ ...vector.media[0]!, sha256: "A".repeat(64) }]
    })).toThrow();
    expect(() => checksumLinkedInPost(vector, "x", 0)).toThrow();
  });
});
