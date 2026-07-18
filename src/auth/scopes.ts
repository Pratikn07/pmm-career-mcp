export const SUPABASE_OAUTH_SCOPES = ["openid", "email"] as const;

/** Accepts the fixed resource scope set once each, in any order. */
export function hasExactSupabaseOAuthScopes(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const scopes = value.split(/\s+/).filter(Boolean);
  const unique = new Set(scopes);
  return scopes.length === SUPABASE_OAUTH_SCOPES.length
    && unique.size === SUPABASE_OAUTH_SCOPES.length
    && SUPABASE_OAUTH_SCOPES.every((scope) => unique.has(scope));
}
