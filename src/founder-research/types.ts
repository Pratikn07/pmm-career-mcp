import type {
  NonFetchingLinkedInProfileUrl
} from "../research/non-fetching-profile-url.js";

/**
 * A LinkedIn profile URL that is safe to store and display, but must never be
 * passed to a page-fetching transport.
 */
export type { NonFetchingLinkedInProfileUrl };

export type FounderEvidenceSource = "OFFICIAL_YC" | "SAVED_PUBLIC_EVIDENCE";

export interface SamePersonFounderEvidence {
  explicitFounder: boolean;
  source: FounderEvidenceSource;
}

export type FounderRoleValidationReason =
  | "INVALID_ROLE_TYPE"
  | "EMPTY_ROLE"
  | "ROLE_TOO_LONG"
  | "ROLE_TOO_LARGE"
  | "UNSAFE_ROLE_CHARACTERS"
  | "PLAIN_CEO_REQUIRES_SAME_PERSON_FOUNDER_EVIDENCE"
  | "NOT_FOUNDER_ROLE";

export type FounderRoleValidationResult =
  | {
      ok: true;
      basis: "EXPLICIT_FOUNDER_ROLE" | "SAME_PERSON_FOUNDER_EVIDENCE";
      normalizedRole: string;
    }
  | {
      ok: false;
      normalizedRole?: string;
      reason: FounderRoleValidationReason;
    };

export type LinkedInProfileUrlValidationReason =
  | "INVALID_URL_TYPE"
  | "EMPTY_URL"
  | "URL_TOO_LONG"
  | "URL_TOO_LARGE"
  | "INVALID_URL"
  | "WHITESPACE_NOT_ALLOWED"
  | "BACKSLASH_NOT_ALLOWED"
  | "HTTPS_REQUIRED"
  | "CREDENTIALS_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "HOST_NOT_LINKEDIN"
  | "ENCODED_PATH_NOT_ALLOWED"
  | "DOT_SEGMENT_NOT_ALLOWED"
  | "PROFILE_PATH_REQUIRED"
  | "INVALID_PROFILE_SLUG"
  | "PROFILE_SLUG_TOO_LONG"
  | "PROFILE_SLUG_TOO_LARGE"
  | "UNSUPPORTED_QUERY_PARAMETER";

export type LinkedInProfileUrlValidationResult =
  | {
      ok: true;
      value: NonFetchingLinkedInProfileUrl;
    }
  | {
      ok: false;
      reason: LinkedInProfileUrlValidationReason;
    };
