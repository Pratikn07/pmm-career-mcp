import type {
  FounderRoleValidationResult,
  SamePersonFounderEvidence
} from "./types.js";

export const FOUNDER_ROLE_TEXT_LIMITS = Object.freeze({
  characters: 160,
  bytes: 512
});

export const FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT = 512;

export interface ValidateFounderRoleInput {
  role: string;
  samePersonFounderEvidence?: SamePersonFounderEvidence;
}

const UNICODE_WHITESPACE = /\s+/gu;
const UNSAFE_UNICODE_CONTROL = /[\p{Cc}\p{Cf}]/u;
const ROLE_COMPONENT_SEPARATOR = /\s*(?:[&+/|,;·]|\band\b)\s*/iu;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CEO_TITLE = String.raw`(?:ceo|chief\s+executive\s+officer)`;
const FOUNDER_TITLE = String.raw`(?:founder|co[\s\p{Pd}]*founder)`;
const EXPLICIT_FOUNDER_COMPONENT = new RegExp(
  String.raw`^(?:${FOUNDER_TITLE}|founding\s+${CEO_TITLE}|${FOUNDER_TITLE}\s*[\p{Pd}]\s*${CEO_TITLE}|${CEO_TITLE}\s*[\p{Pd}]\s*${FOUNDER_TITLE})$`,
  "iu"
);
const FOUNDER_REFERENCE = new RegExp(
  String.raw`(?:${FOUNDER_TITLE}|founding\s+${CEO_TITLE})`,
  "iu"
);
const CEO_COMPONENT = new RegExp(`^${CEO_TITLE}$`, "iu");
const PERSON_IDENTITY_LIMITS = Object.freeze({
  characters: 200,
  bytes: 512
});

function characterCount(value: string): number {
  return Array.from(value).length;
}

function normalizeRole(value: string): string {
  return value.normalize("NFC").replace(UNICODE_WHITESPACE, " ").trim();
}

function normalizePersonIdentity(value: string): string | undefined {
  if (
    value.length > PERSON_IDENTITY_LIMITS.bytes
    || UNSAFE_UNICODE_CONTROL.test(value)
  ) {
    return undefined;
  }
  const normalized = normalizeRole(value);
  if (
    normalized === ""
    || characterCount(normalized) > PERSON_IDENTITY_LIMITS.characters
    || Buffer.byteLength(normalized, "utf8") > PERSON_IDENTITY_LIMITS.bytes
  ) {
    return undefined;
  }
  return normalized.toLocaleLowerCase("en-US");
}

function isBoundedStableId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function hasSamePersonFounderEvidence(
  evidence: SamePersonFounderEvidence | undefined
): boolean {
  if (
    evidence === undefined
    || evidence === null
    || typeof evidence !== "object"
    || evidence.explicitFounder !== true
    || (evidence.source !== "OFFICIAL_YC"
      && evidence.source !== "SAVED_PUBLIC_EVIDENCE")
    || !isBoundedStableId(evidence.companyId)
    || !isBoundedStableId(evidence.evidenceId)
  ) {
    return false;
  }

  if (evidence.bindingKind === "NORMALIZED_IDENTITY") {
    const assertedIdentity = normalizePersonIdentity(
      evidence.assertedPersonIdentity
    );
    const expectedIdentity = normalizePersonIdentity(
      evidence.expectedPersonIdentity
    );
    return assertedIdentity !== undefined
      && expectedIdentity !== undefined
      && assertedIdentity === expectedIdentity;
  }

  if (evidence.bindingKind === "RUN_PERSON_ID") {
    return isBoundedStableId(evidence.assertedRunPersonId)
      && isBoundedStableId(evidence.expectedRunPersonId)
      && evidence.assertedRunPersonId === evidence.expectedRunPersonId;
  }

  return false;
}

function splitRoleComponents(normalizedRole: string): string[] {
  return normalizedRole
    .split(ROLE_COMPONENT_SEPARATOR)
    .map((component) => component.trim())
    .filter((component) => component !== "");
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

  if (input.role.length > FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT) {
    return {
      ok: false,
      reason: "ROLE_TOO_LONG"
    };
  }
  if (UNSAFE_UNICODE_CONTROL.test(input.role)) {
    return {
      ok: false,
      reason: "UNSAFE_ROLE_CHARACTERS"
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
  if (characterCount(normalizedRole) > FOUNDER_ROLE_TEXT_LIMITS.characters) {
    return {
      ok: false,
      reason: "ROLE_TOO_LONG"
    };
  }
  if (Buffer.byteLength(normalizedRole, "utf8") > FOUNDER_ROLE_TEXT_LIMITS.bytes) {
    return {
      ok: false,
      reason: "ROLE_TOO_LARGE"
    };
  }

  const components = splitRoleComponents(normalizedRole);
  if (components.some((component) => EXPLICIT_FOUNDER_COMPONENT.test(component))) {
    return {
      ok: true,
      basis: "EXPLICIT_FOUNDER_ROLE",
      normalizedRole
    };
  }

  if (FOUNDER_REFERENCE.test(normalizedRole)) {
    return {
      ok: false,
      normalizedRole,
      reason: "NOT_FOUNDER_ROLE"
    };
  }

  if (components.some((component) => CEO_COMPONENT.test(component))) {
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
