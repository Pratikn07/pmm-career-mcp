const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const WHITESPACE = /\s+/gu;
const LETTER_SEPARATOR_SEQUENCE =
  /(?:\p{L}[\p{P}\p{S}]\s*){3,}\p{L}/gu;

const META_INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,100}\b(?:instructions?|rules?|prompts?|messages?|commands?)\b/iu,
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,100}\b(?:above|previous|prior|everything|all)\b/iu,
  /\b(?:follow|obey|execute|apply)\b.{0,100}\b(?:instructions?|directions?|steps?|commands?)\b/iu
] as const;

const SENSITIVE_ACTION_PATTERN =
  /\b(?:return|reveal|expose|print|send|share|leak)\b.{0,100}\b(?:private|personal|sensitive|system|developer|secret|credentials?|tokens?|keys?|data)\b/iu;

function normalizedSecurityText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cf}]/gu, "")
    .replace(LETTER_SEPARATOR_SEQUENCE, (sequence) => (
      sequence.replace(/[^\p{L}\p{N}]/gu, "")
    ))
    .replace(WHITESPACE, " ")
    .trim();
}

export function hasUntrustedMetaInstruction(value: string): boolean {
  const normalized = normalizedSecurityText(value);
  return META_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function containsSensitiveDisclosureRequest(value: string): boolean {
  return SENSITIVE_ACTION_PATTERN.test(normalizedSecurityText(value));
}

export function containsUntrustedInstruction(value: string): boolean {
  const normalized = normalizedSecurityText(value);
  return [
    ...META_INSTRUCTION_PATTERNS,
    SENSITIVE_ACTION_PATTERN,
    /\b(?:system|developer|assistant)\s*:\s*/iu,
    /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/iu,
    /\b(?:you are|act as)\s+(?:chatgpt|an?\s+(?:ai|language model))/iu,
    /\btool\s*(?:call|use|invocation)\b/iu,
    /\b(?:call|invoke|use)\b.{0,40}\b(?:the\s+)?tool\b/iu
  ].some((pattern) => pattern.test(normalized));
}

export type UntrustedEntityLabelKind = "company" | "person" | "role";

const COMPANY_LABEL =
  /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}&'’.,()+/\p{Pd}\s]*$/u;
const PERSON_LABEL =
  /^[\p{L}\p{M}][\p{L}\p{M}'’. \p{Pd}]*$/u;
const ROLE_LABEL =
  /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}&'’.,()+/\p{Pd}\s]*$/u;

export function isSafeUntrustedEntityLabel(
  value: string,
  kind: UntrustedEntityLabelKind
): boolean {
  if (CONTROL_CHARACTERS.test(value) || containsUntrustedInstruction(value)) {
    return false;
  }
  const normalized = value.normalize("NFC").replace(WHITESPACE, " ").trim();
  if (normalized === "") {
    return false;
  }
  const words = normalized.split(" ");
  switch (kind) {
    case "company":
      return words.length <= 16 && COMPANY_LABEL.test(normalized);
    case "person":
      return words.length >= 2
        && words.length <= 10
        && PERSON_LABEL.test(normalized)
        && words.every((word) => /\p{L}/u.test(word));
    case "role":
      return words.length <= 20 && ROLE_LABEL.test(normalized);
  }
}
