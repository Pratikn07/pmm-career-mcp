export const REDACTED_VALUE = "[REDACTED]";
export const TRUNCATED_VALUE = "[TRUNCATED]";

const MAX_DEPTH = 24;
const MAX_NODES = 10_000;
const MAX_STRING_LENGTH = 16_384;
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "state",
  "previewtoken"
]);
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "version",
  "algorithm",
  "iv",
  "authtag",
  "ciphertext"
]);

function normalizedKey(key: string): string {
  return key.toLocaleLowerCase("en").replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.startsWith("authorization") || SECRET_KEYS.has(normalized);
}

function isEncryptedEnvelopeLike(value: object): boolean {
  const normalized = Object.keys(value).map(normalizedKey);
  return normalized.length === ENVELOPE_KEYS.size
    && normalized.every((key) => ENVELOPE_KEYS.has(key));
}

function defineEnumerable(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

export function redactSecrets(value: unknown): unknown {
  let nodes = 0;
  const copies = new WeakMap<object, object>();

  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      return TRUNCATED_VALUE;
    }
    if (typeof current === "string") {
      return current.length <= MAX_STRING_LENGTH ? current : TRUNCATED_VALUE;
    }
    if (
      current === null
      || typeof current === "number"
      || typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current !== "object") {
      return TRUNCATED_VALUE;
    }
    if (isEncryptedEnvelopeLike(current)) {
      return REDACTED_VALUE;
    }
    const prior = copies.get(current);
    if (prior !== undefined) {
      return prior;
    }
    if (Array.isArray(current)) {
      const output: unknown[] = [];
      copies.set(current, output);
      for (let index = 0; index < current.length; index += 1) {
        if (Object.hasOwn(current, index)) {
          output[index] = visit(current[index], depth + 1);
        }
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    copies.set(current, output);
    for (const key of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      const redacted = isSecretKey(key)
        ? REDACTED_VALUE
        : descriptor !== undefined && "value" in descriptor
          ? visit(descriptor.value, depth + 1)
          : TRUNCATED_VALUE;
      defineEnumerable(output, key, redacted);
    }
    return output;
  };

  return visit(value, 0);
}
