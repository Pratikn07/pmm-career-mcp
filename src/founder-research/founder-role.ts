import type {
  FounderRoleValidationContext,
  FounderRoleValidationResult
} from "./types.js";

export const FOUNDER_ROLE_TEXT_LIMITS = Object.freeze({
  characters: 160,
  bytes: 512
});

export const FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT = 512;

const PERSON_NAME_LIMITS = Object.freeze({
  characters: 200,
  bytes: 512
});
const QUALIFIED_COMPANY_LIMITS = Object.freeze({
  characters: 80,
  bytes: 256
});

const UNICODE_WHITESPACE = /\s+/gu;
const UNSAFE_UNICODE_CONTROL = /[\p{Cc}\p{Cf}]/u;
const SEMANTIC_SEPARATOR = /[\p{P}\p{S}]+/gu;
const SEMANTIC_COMPONENT_WORD_SEPARATOR = /\band\b/giu;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAME_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\p{Pd}-]*/gu;
const ROLE_COMPONENT_SEPARATOR = /\s*(?:[&+|,;·]|\band\b)\s*|\s+\/\s+/iu;

const CEO_TITLE = String.raw`(?:ceo|chief\s+executive\s+officer)`;
const FOUNDER_TITLE = String.raw`(?:founder|co[\s\p{Pd}]*founder)`;
const FOUNDER_CEO_TITLE = String.raw`(?:${FOUNDER_TITLE}\s*[/\p{Pd}]\s*${CEO_TITLE}|${CEO_TITLE}\s*[/\p{Pd}]\s*${FOUNDER_TITLE})`;
const EXPLICIT_FOUNDER_TITLE = String.raw`(?:${FOUNDER_TITLE}|founding\s+${CEO_TITLE}|${FOUNDER_CEO_TITLE})`;

const EXPLICIT_FOUNDER_COMPONENT = new RegExp(
  `^${EXPLICIT_FOUNDER_TITLE}$`,
  "iu"
);
const QUALIFIED_FOUNDER_COMPONENT = new RegExp(
  `^(${EXPLICIT_FOUNDER_TITLE})\\s+(?:at|of)\\s+(.+)$`,
  "iu"
);
const FOUNDER_REFERENCE = new RegExp(
  String.raw`(?:${FOUNDER_TITLE}|founding\s+${CEO_TITLE})`,
  "iu"
);
const NEGATED_FOUNDER_REFERENCE = new RegExp(
  String.raw`(?:\bnot\s+(?:an?\s+)?(?:co[\s\p{Pd}]*)?founder\b|\bnon[\s\p{Pd}]*(?:co[\s\p{Pd}]*)?founder\b)`,
  "iu"
);
const SEMANTIC_FOUNDER_REFERENCE = String.raw`(?:founder|cofounder|co\s+founder)`;
const SEMANTIC_NEGATED_FOUNDER_REFERENCE = new RegExp(
  String.raw`\b(?:not\s+(?:(?:a|the)\s+)?|non\s+)${SEMANTIC_FOUNDER_REFERENCE}\b`,
  "u"
);
const SEMANTIC_RELATIONAL_FOUNDER_REFERENCE = new RegExp(
  String.raw`\b(?:(?:(?:executive|personal|senior|junior)\s+)?(?:advisor|adviser|assistant|associate|manager|liaison|support|representative)|relations?(?:\s+manager)?|chief\s+of\s+staff|founder\s+relations(?:\s+manager)?)\s+to\s+(?:(?:a|the)\s+)?${SEMANTIC_FOUNDER_REFERENCE}\b`,
  "u"
);
const CEO_COMPONENT = new RegExp(`^${CEO_TITLE}$`, "iu");

function characterCount(value: string): number {
  return Array.from(value).length;
}

function normalizeWhitespace(value: string): string {
  return value.normalize("NFC").replace(UNICODE_WHITESPACE, " ").trim();
}

function semanticRoleScan(value: string): string {
  return normalizeWhitespace(
    value
      .replace(SEMANTIC_SEPARATOR, " ")
      .replace(SEMANTIC_COMPONENT_WORD_SEPARATOR, " ")
  ).toLocaleLowerCase("en-US");
}

function isBoundedStableId(value: unknown): value is string {
  return typeof value === "string" && STABLE_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fullNameTokenSignature(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length > PERSON_NAME_LIMITS.bytes
    || UNSAFE_UNICODE_CONTROL.test(value)
  ) {
    return undefined;
  }

  const normalized = normalizeWhitespace(value).toLocaleLowerCase("en-US");
  if (
    normalized === ""
    || characterCount(normalized) > PERSON_NAME_LIMITS.characters
    || Buffer.byteLength(normalized, "utf8") > PERSON_NAME_LIMITS.bytes
  ) {
    return undefined;
  }

  const tokens = normalized.match(NAME_TOKEN);
  if (
    tokens === null
    || tokens.length < 2
    || tokens.some((token) => {
      const letters = token.match(/\p{L}/gu);
      return letters === null || letters.length < 2;
    })
  ) {
    return undefined;
  }

  return [...tokens].sort().join("\u0000");
}

/**
 * Performs structural binding only. The caller must independently load
 * `savedEvidence` from trusted persistence before invoking this pure module.
 */
function hasBoundSamePersonFounderEvidence(
  context: FounderRoleValidationContext | undefined
): boolean {
  if (!isRecord(context) || !isRecord(context.savedEvidence)) {
    return false;
  }

  const evidence = context.savedEvidence;
  if (
    !isBoundedStableId(context.currentPersonId)
    || !isBoundedStableId(context.currentCompanyId)
    || !isBoundedStableId(evidence.boundPersonId)
    || !isBoundedStableId(evidence.boundCompanyId)
    || !isBoundedStableId(evidence.evidenceId)
    || context.currentPersonId !== evidence.boundPersonId
    || context.currentCompanyId !== evidence.boundCompanyId
    || evidence.explicitFounder !== true
    || (evidence.source !== "OFFICIAL_YC"
      && evidence.source !== "SAVED_PUBLIC_EVIDENCE")
  ) {
    return false;
  }

  const currentName = fullNameTokenSignature(context.currentPersonName);
  const assertedName = fullNameTokenSignature(
    evidence.assertedPersonFullName
  );
  return currentName !== undefined
    && assertedName !== undefined
    && currentName === assertedName;
}

function splitRoleComponents(normalizedRole: string): string[] {
  return normalizedRole
    .split(ROLE_COMPONENT_SEPARATOR)
    .map((component) => component.trim())
    .filter((component) => component !== "");
}

function isBoundedQualifiedCompany(value: string): boolean {
  const company = value.trim();
  return company !== ""
    && characterCount(company) <= QUALIFIED_COMPANY_LIMITS.characters
    && Buffer.byteLength(company, "utf8") <= QUALIFIED_COMPANY_LIMITS.bytes
    && /[\p{L}\p{N}]/u.test(company);
}

function isExplicitFounderComponent(component: string): boolean {
  if (EXPLICIT_FOUNDER_COMPONENT.test(component)) {
    return true;
  }
  const qualified = QUALIFIED_FOUNDER_COMPONENT.exec(component);
  return qualified !== null && isBoundedQualifiedCompany(qualified[2]!);
}

export function validateFounderRole(
  role: string,
  context?: FounderRoleValidationContext
): FounderRoleValidationResult {
  if (typeof role !== "string") {
    return {
      ok: false,
      reason: "INVALID_ROLE_TYPE"
    };
  }

  if (role.length > FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT) {
    return {
      ok: false,
      reason: "ROLE_TOO_LONG"
    };
  }
  if (UNSAFE_UNICODE_CONTROL.test(role)) {
    return {
      ok: false,
      reason: "UNSAFE_ROLE_CHARACTERS"
    };
  }

  const normalizedRole = normalizeWhitespace(role);
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
  const semanticScan = semanticRoleScan(normalizedRole);
  if (
    NEGATED_FOUNDER_REFERENCE.test(normalizedRole)
    || SEMANTIC_NEGATED_FOUNDER_REFERENCE.test(semanticScan)
    || SEMANTIC_RELATIONAL_FOUNDER_REFERENCE.test(semanticScan)
  ) {
    return {
      ok: false,
      normalizedRole,
      reason: "NOT_FOUNDER_ROLE"
    };
  }
  if (components.some(isExplicitFounderComponent)) {
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
    if (hasBoundSamePersonFounderEvidence(context)) {
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
