import { describe, expect, it } from "vitest";
import { validateVerifiedTokenClaims } from "../../scripts/verify-oauth-token.js";

const expected = {
  issuer: "https://project.supabase.co/auth/v1",
  audience: "https://career.example",
  subject: "123e4567-e89b-12d3-a456-426614174000"
};

describe("OAuth token verification script helpers", () => {
  it("accepts the exact configured issuer, Base URL audience, expiry, and subject", () => {
    expect(() => validateVerifiedTokenClaims({
      iss: expected.issuer,
      aud: expected.audience,
      exp: Math.floor(Date.now() / 1000) + 60,
      sub: expected.subject
    }, expected)).not.toThrow();
  });

  it.each([
    { label: "array audience", mutate: (claims: Record<string, unknown>) => { claims.aud = [expected.audience]; } },
    { label: "wrong audience", mutate: (claims: Record<string, unknown>) => { claims.aud = "https://other.example"; } },
    { label: "missing subject", mutate: (claims: Record<string, unknown>) => { delete claims.sub; } },
    { label: "expired", mutate: (claims: Record<string, unknown>) => { claims.exp = Math.floor(Date.now() / 1000) - 1; } }
  ])("rejects $label without including claims in its error", ({ mutate }) => {
    const claims: Record<string, unknown> = {
      iss: expected.issuer,
      aud: expected.audience,
      exp: Math.floor(Date.now() / 1000) + 60,
      sub: expected.subject
    };
    mutate(claims);
    expect(() => validateVerifiedTokenClaims(claims, expected)).toThrow("OAuth token verification failed");
  });
});
