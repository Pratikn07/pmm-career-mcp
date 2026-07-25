import type {
  LinkedInProfileUrlValidationResult,
  NonFetchingLinkedInProfileUrl
} from "./types.js";

export const LINKEDIN_PROFILE_URL_LIMITS = Object.freeze({
  characters: 2_048,
  bytes: 4_096,
  slugCharacters: 100,
  slugBytes: 256
});

const PROFILE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const TRACKING_QUERY_PARAMETERS = new Set([
  "ebp",
  "lipi",
  "midtoken",
  "originalsubdomain",
  "refid",
  "trackingid",
  "trk",
  "trkinfo"
]);

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isLinkedInHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "linkedin.com" || normalized.endsWith(".linkedin.com");
}

function rawAuthority(input: string): string | undefined {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(input);
  return match?.[1];
}

function rawPath(input: string): string {
  const authority = rawAuthority(input);
  if (authority === undefined) {
    return "";
  }
  const pathStart = input.indexOf("/", input.indexOf(authority) + authority.length);
  if (pathStart < 0) {
    return "";
  }
  const queryStart = input.indexOf("?", pathStart);
  const fragmentStart = input.indexOf("#", pathStart);
  const pathEnd = [queryStart, fragmentStart]
    .filter((position) => position >= 0)
    .reduce((earliest, position) => Math.min(earliest, position), input.length);
  return input.slice(pathStart, pathEnd);
}

function containsExplicitPort(authority: string): boolean {
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostAndPort.includes(":");
}

function isTrackingQueryParameter(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("utm_")
    || TRACKING_QUERY_PARAMETERS.has(normalized);
}

export function validateNonFetchingLinkedInProfileUrl(
  input: string
): LinkedInProfileUrlValidationResult {
  if (typeof input !== "string") {
    return {
      ok: false,
      reason: "INVALID_URL_TYPE"
    };
  }
  if (input === "") {
    return {
      ok: false,
      reason: "EMPTY_URL"
    };
  }
  if (characterCount(input) > LINKEDIN_PROFILE_URL_LIMITS.characters) {
    return {
      ok: false,
      reason: "URL_TOO_LONG"
    };
  }
  if (Buffer.byteLength(input, "utf8") > LINKEDIN_PROFILE_URL_LIMITS.bytes) {
    return {
      ok: false,
      reason: "URL_TOO_LARGE"
    };
  }
  if (input.includes("\\")) {
    return {
      ok: false,
      reason: "BACKSLASH_NOT_ALLOWED"
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return {
      ok: false,
      reason: "INVALID_URL"
    };
  }

  if (/\s/u.test(input)) {
    return {
      ok: false,
      reason: "WHITESPACE_NOT_ALLOWED"
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "HTTPS_REQUIRED"
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      reason: "CREDENTIALS_NOT_ALLOWED"
    };
  }

  const authority = rawAuthority(input);
  if (authority === undefined) {
    return {
      ok: false,
      reason: "INVALID_URL"
    };
  }
  if (containsExplicitPort(authority)) {
    return {
      ok: false,
      reason: "PORT_NOT_ALLOWED"
    };
  }
  if (!isLinkedInHostname(parsed.hostname)) {
    return {
      ok: false,
      reason: "HOST_NOT_LINKEDIN"
    };
  }

  const sourcePath = rawPath(input);
  if (sourcePath.includes("%")) {
    return {
      ok: false,
      reason: "ENCODED_PATH_NOT_ALLOWED"
    };
  }
  if (sourcePath.split("/").some((segment) => segment === "." || segment === "..")) {
    return {
      ok: false,
      reason: "DOT_SEGMENT_NOT_ALLOWED"
    };
  }

  const pathMatch = /^\/in\/([^/]+)\/?$/u.exec(parsed.pathname);
  if (pathMatch === null) {
    return {
      ok: false,
      reason: "PROFILE_PATH_REQUIRED"
    };
  }

  const slug = pathMatch[1]!;
  if (!PROFILE_SLUG.test(slug)) {
    return {
      ok: false,
      reason: "INVALID_PROFILE_SLUG"
    };
  }
  if (characterCount(slug) > LINKEDIN_PROFILE_URL_LIMITS.slugCharacters) {
    return {
      ok: false,
      reason: "PROFILE_SLUG_TOO_LONG"
    };
  }
  if (Buffer.byteLength(slug, "utf8") > LINKEDIN_PROFILE_URL_LIMITS.slugBytes) {
    return {
      ok: false,
      reason: "PROFILE_SLUG_TOO_LARGE"
    };
  }

  for (const parameterName of parsed.searchParams.keys()) {
    if (!isTrackingQueryParameter(parameterName)) {
      return {
        ok: false,
        reason: "UNSUPPORTED_QUERY_PARAMETER"
      };
    }
  }

  return {
    ok: true,
    value: `https://www.linkedin.com/in/${slug}` as NonFetchingLinkedInProfileUrl
  };
}
