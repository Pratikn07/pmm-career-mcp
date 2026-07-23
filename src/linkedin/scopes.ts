export const LINKEDIN_REQUIRED_SCOPES = Object.freeze([
  "openid",
  "profile",
  "w_member_social"
] as const);

const LINKEDIN_OPTIONAL_REPORTED_SCOPES = new Set<string>(["email"]);

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
  const scopes = value.trim() === "" ? [] : value.trim().split(/\s+/u);
  if (new Set(scopes).size !== scopes.length) return undefined;

  const allowed = new Set<string>([
    ...LINKEDIN_REQUIRED_SCOPES,
    ...LINKEDIN_OPTIONAL_REPORTED_SCOPES
  ]);
  if (scopes.some((scope) => !allowed.has(scope))) return undefined;

  const actual = new Set(scopes);
  return LINKEDIN_REQUIRED_SCOPES.every((scope) => actual.has(scope))
    ? [...LINKEDIN_REQUIRED_SCOPES]
    : undefined;
}
