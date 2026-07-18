const SUPABASE_AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9]{32}$/;

/**
 * Supabase OAuth authorization IDs are opaque SecureAlphanumeric(32) values.
 * Keep this browser-safe helper dependency-free so the same check is bundled
 * into the consent client and used by the server route.
 */
export function isSupabaseAuthorizationId(value: string): boolean {
  return SUPABASE_AUTHORIZATION_ID_PATTERN.test(value);
}
