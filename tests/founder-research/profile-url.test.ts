import { describe, expect, expectTypeOf, it } from "vitest";

import {
  LINKEDIN_PROFILE_URL_LIMITS,
  validateNonFetchingLinkedInProfileUrl
} from "../../src/founder-research/profile-url.js";
import type {
  LinkedInProfileUrlValidationResult,
  NonFetchingLinkedInProfileUrl
} from "../../src/founder-research/types.js";
import type {
  NonFetchingLinkedInProfileUrl as ExistingNonFetchingLinkedInProfileUrl
} from "../../src/research/non-fetching-profile-url.js";

describe("validateNonFetchingLinkedInProfileUrl", () => {
  it.each([
    "https://linkedin.com/in/ada-lovelace",
    "https://www.linkedin.com/in/ada-lovelace/",
    "https://uk.linkedin.com/in/Ada_Lovelace"
  ])("accepts and canonicalizes the profile URL %j", (input) => {
    const result = validateNonFetchingLinkedInProfileUrl(input);

    expect(result).toEqual({
      ok: true,
      value: input.includes("Ada_Lovelace")
        ? "https://www.linkedin.com/in/Ada_Lovelace"
        : "https://www.linkedin.com/in/ada-lovelace"
    });
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<NonFetchingLinkedInProfileUrl>();
    }
  });

  it("removes fragments and all recognized duplicate tracking parameters", () => {
    expect(validateNonFetchingLinkedInProfileUrl(
      "https://www.linkedin.com/in/ada-lovelace/?trk=public_profile&trk=duplicate&utm_source=newsletter&originalSubdomain=uk#about"
    )).toEqual({
      ok: true,
      value: "https://www.linkedin.com/in/ada-lovelace"
    });
  });

  it.each([
    ["HTTP", "http://www.linkedin.com/in/ada-lovelace", "HTTPS_REQUIRED"],
    ["credentials", "https://user:pass@www.linkedin.com/in/ada-lovelace", "CREDENTIALS_NOT_ALLOWED"],
    ["custom port", "https://www.linkedin.com:444/in/ada-lovelace", "PORT_NOT_ALLOWED"],
    ["explicit default port", "https://www.linkedin.com:443/in/ada-lovelace", "PORT_NOT_ALLOWED"],
    ["host suffix trap", "https://linkedin.com.evil.example/in/ada-lovelace", "HOST_NOT_LINKEDIN"],
    ["host prefix trap", "https://evillinkedin.com/in/ada-lovelace", "HOST_NOT_LINKEDIN"],
    ["shortened link", "https://lnkd.in/abc123", "HOST_NOT_LINKEDIN"],
    ["company path", "https://www.linkedin.com/company/acme", "PROFILE_PATH_REQUIRED"],
    ["jobs path", "https://www.linkedin.com/jobs/view/1", "PROFILE_PATH_REQUIRED"],
    ["feed path", "https://www.linkedin.com/feed/", "PROFILE_PATH_REQUIRED"],
    ["search path", "https://www.linkedin.com/search/results/people/", "PROFILE_PATH_REQUIRED"],
    ["posts path", "https://www.linkedin.com/posts/ada_lovelace", "PROFILE_PATH_REQUIRED"],
    ["extra profile segment", "https://www.linkedin.com/in/ada-lovelace/details", "PROFILE_PATH_REQUIRED"],
    ["backslash path", "https://www.linkedin.com\\in\\ada-lovelace", "BACKSLASH_NOT_ALLOWED"],
    ["unsupported query", "https://www.linkedin.com/in/ada-lovelace?foo=bar", "UNSUPPORTED_QUERY_PARAMETER"],
    ["malformed URL", "not a URL", "INVALID_URL"],
    ["non-LinkedIn URL", "https://example.com/in/ada-lovelace", "HOST_NOT_LINKEDIN"]
  ])("rejects %s", (_name, input, reason) => {
    expect(validateNonFetchingLinkedInProfileUrl(input)).toEqual({
      ok: false,
      reason
    });
  });

  it.each([
    "https://www.linkedin.com/in/ada%2Flovelace",
    "https://www.linkedin.com/in/ada%5Clovelace",
    "https://www.linkedin.com/%69n/ada-lovelace",
    "https://www.linkedin.com/in/%2e%2e",
    "https://www.linkedin.com/in/%252e%252e"
  ])("rejects encoded profile paths without decoding them", (input) => {
    expect(validateNonFetchingLinkedInProfileUrl(input)).toEqual({
      ok: false,
      reason: "ENCODED_PATH_NOT_ALLOWED"
    });
  });

  it.each([
    "https://www.linkedin.com/in/../in/ada-lovelace",
    "https://www.linkedin.com/./in/ada-lovelace",
    "https://www.linkedin.com/in/ada-lovelace/.."
  ])("rejects path dot segments before URL normalization", (input) => {
    expect(validateNonFetchingLinkedInProfileUrl(input)).toEqual({
      ok: false,
      reason: "DOT_SEGMENT_NOT_ALLOWED"
    });
  });

  it.each([
    " https://www.linkedin.com/in/ada-lovelace",
    "https://www.linkedin.com/in/ada-lovelace ",
    "https://www.linkedin.com/in/ada-\tlovelace",
    "https://www.linkedin.com/in/ada-\u00a0lovelace"
  ])("rejects invisible or ambiguous URL whitespace", (input) => {
    expect(validateNonFetchingLinkedInProfileUrl(input)).toEqual({
      ok: false,
      reason: "WHITESPACE_NOT_ALLOWED"
    });
  });

  it.each([
    ["empty slug", "https://www.linkedin.com/in/", "PROFILE_PATH_REQUIRED"],
    ["dot slug", "https://www.linkedin.com/in/.", "DOT_SEGMENT_NOT_ALLOWED"],
    ["invalid slug punctuation", "https://www.linkedin.com/in/ada!lovelace", "INVALID_PROFILE_SLUG"],
    ["Unicode confusable slug", "https://www.linkedin.com/in/аda-lovelace", "INVALID_PROFILE_SLUG"]
  ])("rejects %s", (_name, input, reason) => {
    expect(validateNonFetchingLinkedInProfileUrl(input)).toEqual({
      ok: false,
      reason
    });
  });

  it("returns safe reasons for invalid types and empty input", () => {
    expect(validateNonFetchingLinkedInProfileUrl(7 as unknown as string)).toEqual({
      ok: false,
      reason: "INVALID_URL_TYPE"
    });
    expect(validateNonFetchingLinkedInProfileUrl("")).toEqual({
      ok: false,
      reason: "EMPTY_URL"
    });
  });

  it("enforces independent whole-URL character and byte limits", () => {
    const overCharacters = `https://www.linkedin.com/in/${"a".repeat(LINKEDIN_PROFILE_URL_LIMITS.characters)}`;
    expect(validateNonFetchingLinkedInProfileUrl(overCharacters)).toEqual({
      ok: false,
      reason: "URL_TOO_LONG"
    });

    const overBytes = `https://www.linkedin.com/in/${"😀".repeat(
      LINKEDIN_PROFILE_URL_LIMITS.characters - 32
    )}`;
    expect(validateNonFetchingLinkedInProfileUrl(overBytes)).toEqual({
      ok: false,
      reason: "URL_TOO_LARGE"
    });
  });

  it("exposes a stable discriminated result contract", () => {
    expectTypeOf(validateNonFetchingLinkedInProfileUrl)
      .returns.toEqualTypeOf<LinkedInProfileUrlValidationResult>();
    expectTypeOf<NonFetchingLinkedInProfileUrl>()
      .toEqualTypeOf<ExistingNonFetchingLinkedInProfileUrl>();
  });
});
