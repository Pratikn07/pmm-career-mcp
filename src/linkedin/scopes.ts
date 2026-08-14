export const LINKEDIN_REQUIRED_SCOPES = Object.freeze([
  "openid",
  "profile",
  "w_member_social"
] as const);

export function exactLinkedInScopes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length !== LINKEDIN_REQUIRED_SCOPES.length) {
    return undefined;
  }
  const scopes = value.filter((scope): scope is string => typeof scope === "string");
  if (scopes.length !== value.length || new Set(scopes).size !== scopes.length) {
    return undefined;
  }
  const actual = new Set(scopes);
  return LINKEDIN_REQUIRED_SCOPES.every((scope) => actual.has(scope))
    ? [...LINKEDIN_REQUIRED_SCOPES]
    : undefined;
}

export function scopesFromTokenResponse(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [...LINKEDIN_REQUIRED_SCOPES];
  if (typeof value !== "string" || value.length > 1_024) return undefined;
  const normalized = value.trim();
  const scopes = normalized === ""
    ? []
    : normalized.includes(",")
      ? normalized.split(",").map((scope) => scope.trim())
      : normalized.split(/\s+/u);
  if (scopes.some((scope) => scope.length === 0)) return undefined;
  return exactLinkedInScopes(scopes);
}
