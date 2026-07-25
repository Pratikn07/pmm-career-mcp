import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FOUNDER_ROLE_TEXT_LIMITS,
  validateFounderRole
} from "../../src/founder-research/founder-role.js";
import type { FounderRoleValidationResult } from "../../src/founder-research/types.js";

describe("validateFounderRole", () => {
  it.each([
    "Founder",
    "co-founder",
    "Cofounder",
    "Co Founder",
    "Founding CEO",
    "Founding Chief Executive Officer",
    "Founder/CEO",
    "CEO & Co-Founder",
    "Chief Executive Officer and Founder"
  ])("accepts the explicit founder role %j", (role) => {
    expect(validateFounderRole({ role })).toMatchObject({
      ok: true,
      basis: "EXPLICIT_FOUNDER_ROLE"
    });
  });

  it("normalizes Unicode to NFC and collapses Unicode whitespace", () => {
    const result = validateFounderRole({
      role: " \tCo-Founder\u00a0&\nCafe\u0301 Lead "
    });

    expect(result).toEqual({
      ok: true,
      basis: "EXPLICIT_FOUNDER_ROLE",
      normalizedRole: "Co-Founder & Café Lead"
    });
  });

  it.each([
    "Founding Engineer",
    "Founding Designer",
    "Investor",
    "Advisor",
    "Chief Marketing Officer",
    "Chief Executive Officer",
    "Founder's Associate",
    "Founder Relations Manager"
  ])("rejects the non-founder role %j", (role) => {
    expect(validateFounderRole({ role })).toMatchObject({
      ok: false,
      reason: role === "Chief Executive Officer"
        ? "PLAIN_CEO_REQUIRES_SAME_PERSON_FOUNDER_EVIDENCE"
        : "NOT_FOUNDER_ROLE"
    });
  });

  it("accepts a mixed founding-specialist role only when founder is separately asserted", () => {
    expect(validateFounderRole({ role: "Co-Founder / Founding Engineer" })).toMatchObject({
      ok: true,
      basis: "EXPLICIT_FOUNDER_ROLE"
    });
  });

  it.each(["CEO", "Chief Executive Officer"])(
    "accepts plain %s only with explicit same-person founder evidence",
    (role) => {
      expect(validateFounderRole({
        role,
        samePersonFounderEvidence: {
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      })).toEqual({
        ok: true,
        basis: "SAME_PERSON_FOUNDER_EVIDENCE",
        normalizedRole: role
      });

      expect(validateFounderRole({
        role,
        samePersonFounderEvidence: {
          explicitFounder: true,
          source: "SAVED_PUBLIC_EVIDENCE"
        }
      })).toMatchObject({
        ok: true,
        basis: "SAME_PERSON_FOUNDER_EVIDENCE"
      });
    }
  );

  it("does not accept CEO evidence that is not an explicit same-person founder assertion", () => {
    expect(validateFounderRole({
      role: "CEO",
      samePersonFounderEvidence: {
        explicitFounder: false,
        source: "OFFICIAL_YC"
      }
    })).toEqual({
      ok: false,
      normalizedRole: "CEO",
      reason: "PLAIN_CEO_REQUIRES_SAME_PERSON_FOUNDER_EVIDENCE"
    });
  });

  it.each([
    ["Cyrillic confusable", "Fоunder", "NOT_FOUNDER_ROLE"],
    ["full-width confusable", "Ｆｏｕｎｄｅｒ", "NOT_FOUNDER_ROLE"],
    ["zero-width insertion", "Fo\u200bunder", "UNSAFE_ROLE_CHARACTERS"]
  ])("rejects %s text", (_name, role, reason) => {
    expect(validateFounderRole({ role })).toMatchObject({
      ok: false,
      reason
    });
  });

  it.each([
    ["zero-width suffix", "Founder\u200b"],
    ["directional override", "Founder\u202e"]
  ])("rejects an explicit role containing a Unicode format control: %s", (_name, role) => {
    expect(validateFounderRole({ role })).toMatchObject({
      ok: false,
      reason: "UNSAFE_ROLE_CHARACTERS"
    });
  });

  it("returns safe structured reasons for empty and invalid values", () => {
    expect(validateFounderRole({ role: " \u00a0 " })).toEqual({
      ok: false,
      normalizedRole: "",
      reason: "EMPTY_ROLE"
    });
    expect(validateFounderRole({ role: 42 as unknown as string })).toEqual({
      ok: false,
      reason: "INVALID_ROLE_TYPE"
    });
  });

  it("enforces independent character and UTF-8 byte limits", () => {
    expect(validateFounderRole({
      role: `Founder ${"a".repeat(FOUNDER_ROLE_TEXT_LIMITS.characters)}`
    })).toMatchObject({
      ok: false,
      reason: "ROLE_TOO_LONG"
    });

    expect(validateFounderRole({
      role: `Founder ${"😀".repeat(FOUNDER_ROLE_TEXT_LIMITS.characters - 8)}`
    })).toMatchObject({
      ok: false,
      reason: "ROLE_TOO_LARGE"
    });
  });

  it("exposes a stable discriminated result contract", () => {
    expectTypeOf(validateFounderRole).returns.toEqualTypeOf<FounderRoleValidationResult>();
  });
});
