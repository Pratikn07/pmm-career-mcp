import type {
  FounderRoleValidationResult,
  SamePersonFounderEvidence
} from "./types.js";

export const FOUNDER_ROLE_TEXT_LIMITS = Object.freeze({
  characters: 160,
  bytes: 512
});

export interface ValidateFounderRoleInput {
  role: string;
  samePersonFounderEvidence?: SamePersonFounderEvidence;
}

const UNICODE_WHITESPACE = /\s+/gu;
const WORD_CHARACTER = String.raw`\p{L}\p{N}`;
const ROLE_BOUNDARY_START = String.raw`(?:^|[^${WORD_CHARACTER}])`;
const ROLE_BOUNDARY_END = String.raw`(?=$|[^${WORD_CHARACTER}])`;
const DASH_OR_SPACE = String.raw`[\s\p{Pd}]*`;

const CO_FOUNDER_ROLE = new RegExp(
  `${ROLE_BOUNDARY_START}co${DASH_OR_SPACE}founder${ROLE_BOUNDARY_END}`,
  "iu"
);
const FOUNDER_ROLE = new RegExp(
  `${ROLE_BOUNDARY_START}founder(?!['’]s)${ROLE_BOUNDARY_END}`,
  "iu"
);
const FOUNDING_CEO_ROLE = new RegExp(
  `${ROLE_BOUNDARY_START}founding\\s+(?:ceo|chief\\s+executive\\s+officer)${ROLE_BOUNDARY_END}`,
  "iu"
);
const CEO_ROLE = new RegExp(
  `${ROLE_BOUNDARY_START}(?:ceo|chief\\s+executive\\s+officer)${ROLE_BOUNDARY_END}`,
  "iu"
);
const NON_FOUNDER_FOUNDER_PHRASE = new RegExp(
  `${ROLE_BOUNDARY_START}founder(?:['’]s|\\s+(?:relations?|associate|success|community|program))${ROLE_BOUNDARY_END}`,
  "giu"
);

function characterCount(value: string): number {
  return Array.from(value).length;
}

function normalizeRole(value: string): string {
  return value.normalize("NFC").replace(UNICODE_WHITESPACE, " ").trim();
}

function hasSamePersonFounderEvidence(
  evidence: SamePersonFounderEvidence | undefined
): boolean {
  return evidence?.explicitFounder === true
    && (evidence.source === "OFFICIAL_YC"
      || evidence.source === "SAVED_PUBLIC_EVIDENCE");
}

export function validateFounderRole(
  input: ValidateFounderRoleInput
): FounderRoleValidationResult {
  if (typeof input?.role !== "string") {
    return {
      ok: false,
      reason: "INVALID_ROLE_TYPE"
    };
  }

  const normalizedRole = normalizeRole(input.role);
  if (normalizedRole === "") {
    return {
      ok: false,
      normalizedRole,
      reason: "EMPTY_ROLE"
    };
  }
  if (/\p{Cf}/u.test(normalizedRole)) {
    return {
      ok: false,
      normalizedRole,
      reason: "UNSAFE_ROLE_CHARACTERS"
    };
  }

  if (characterCount(normalizedRole) > FOUNDER_ROLE_TEXT_LIMITS.characters) {
    return {
      ok: false,
      normalizedRole,
      reason: "ROLE_TOO_LONG"
    };
  }
  if (Buffer.byteLength(normalizedRole, "utf8") > FOUNDER_ROLE_TEXT_LIMITS.bytes) {
    return {
      ok: false,
      normalizedRole,
      reason: "ROLE_TOO_LARGE"
    };
  }

  const withoutFalsePositivePhrases = normalizedRole.replace(
    NON_FOUNDER_FOUNDER_PHRASE,
    " "
  );
  if (
    CO_FOUNDER_ROLE.test(withoutFalsePositivePhrases)
    || FOUNDER_ROLE.test(withoutFalsePositivePhrases)
    || FOUNDING_CEO_ROLE.test(withoutFalsePositivePhrases)
  ) {
    return {
      ok: true,
      basis: "EXPLICIT_FOUNDER_ROLE",
      normalizedRole
    };
  }

  if (CEO_ROLE.test(normalizedRole)) {
    if (hasSamePersonFounderEvidence(input.samePersonFounderEvidence)) {
      return {
        ok: true,
        basis: "SAME_PERSON_FOUNDER_EVIDENCE",
        normalizedRole
      };
    }
    return {
      ok: false,
      normalizedRole,
      reason: "PLAIN_CEO_REQUIRES_SAME_PERSON_FOUNDER_EVIDENCE"
    };
  }

  return {
    ok: false,
    normalizedRole,
    reason: "NOT_FOUNDER_ROLE"
  };
}
