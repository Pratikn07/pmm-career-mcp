import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT,
  FOUNDER_ROLE_TEXT_LIMITS,
  validateFounderRole
} from "../../src/founder-research/founder-role.js";
import type {
  FounderRoleValidationContext,
  FounderRoleValidationResult
} from "../../src/founder-research/types.js";

function evidenceContext(
  overrides: Record<string, unknown> = {}
): FounderRoleValidationContext {
  return {
    currentCompanyId: "yc-acme",
    currentPersonId: "run-person-123",
    currentPersonName: "Ada Lovelace",
    savedEvidence: {
      assertedPersonFullName: "Ada Lovelace",
      boundCompanyId: "yc-acme",
      boundPersonId: "run-person-123",
      evidenceId: "evidence-1",
      explicitFounder: true,
      source: "OFFICIAL_YC"
    },
    ...overrides
  } as FounderRoleValidationContext;
}

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
    "Chief Executive Officer and Founder",
    "Founder at Acme",
    "Co-Founder of Acme, Inc.",
    "CEO & Founder at Acme",
    "Founder/CEO at Acme"
  ])("accepts the explicit founder role %j", (role) => {
    expect(validateFounderRole(role)).toMatchObject({
      ok: true,
      basis: "EXPLICIT_FOUNDER_ROLE"
    });
  });

  it("normalizes Unicode to NFC and collapses safe Unicode whitespace", () => {
    expect(validateFounderRole(
      " \u2002Co-Founder\u00a0&  Cafe\u0301 Lead "
    )).toEqual({
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
    "Founder Relations Manager",
    "Non-Founder CEO",
    "Not a Founder",
    "Advisor to the Founder",
    "Cofounder Relations Manager",
    "Cofounder's Associate",
    "Advisor to a Co-Founder",
    "Assistant to the Founding CEO",
    "Founder at",
    "Founder of",
    "Founder/CEO at"
  ])("rejects the non-founder role %j", (role) => {
    expect(validateFounderRole(role)).toMatchObject({
      ok: false,
      reason: role === "Chief Executive Officer"
        ? "PLAIN_CEO_REQUIRES_SAME_PERSON_FOUNDER_EVIDENCE"
        : "NOT_FOUNDER_ROLE"
    });
  });

  it("accepts a founder specialist combination only when founder is separately asserted", () => {
    expect(validateFounderRole("Co-Founder / Founding Engineer")).toMatchObject({
      ok: true,
      basis: "EXPLICIT_FOUNDER_ROLE"
    });
  });

  it.each(["CEO", "Chief Executive Officer"])(
    "accepts plain %s when independently trusted context binds saved evidence",
    (role) => {
      expect(validateFounderRole(role, evidenceContext())).toEqual({
        ok: true,
        basis: "SAME_PERSON_FOUNDER_EVIDENCE",
        normalizedRole: role
      });
    }
  );

  it("accepts reordered full-name tokens when all normalized tokens match", () => {
    expect(validateFounderRole("CEO", evidenceContext({
      currentPersonName: "  Ada\u00a0Lovelace ",
      savedEvidence: {
        assertedPersonFullName: "Lovelace, Ada",
        boundCompanyId: "yc-acme",
        boundPersonId: "run-person-123",
        evidenceId: "evidence-reordered",
        explicitFounder: true,
        source: "SAVED_PUBLIC_EVIDENCE"
      }
    }))).toEqual({
      ok: true,
      basis: "SAME_PERSON_FOUNDER_EVIDENCE",
      normalizedRole: "CEO"
    });
  });

  it.each([
    [
      "person-ID mismatch",
      {
        savedEvidence: {
          assertedPersonFullName: "Ada Lovelace",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-999",
          evidenceId: "evidence-person",
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "company-ID mismatch",
      {
        savedEvidence: {
          assertedPersonFullName: "Ada Lovelace",
          boundCompanyId: "yc-other",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-company",
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "full-name mismatch",
      {
        savedEvidence: {
          assertedPersonFullName: "Grace Hopper",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-name",
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "partial-name assertion",
      {
        savedEvidence: {
          assertedPersonFullName: "Ada",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-partial",
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "extra numeric name token",
      {
        savedEvidence: {
          assertedPersonFullName: "Ada Lovelace 123",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-numeric-name",
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "duplicate name-token mismatch",
      {
        savedEvidence: {
          assertedPersonFullName: "Ada Ada Lovelace",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-duplicate-name",
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "initial-only token",
      {
        currentPersonName: "A. Lovelace",
        savedEvidence: {
          assertedPersonFullName: "Lovelace A.",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-initial",
          explicitFounder: true,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "non-explicit founder assertion",
      {
        savedEvidence: {
          assertedPersonFullName: "Ada Lovelace",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-not-explicit",
          explicitFounder: false,
          source: "OFFICIAL_YC"
        }
      }
    ],
    [
      "unknown evidence source",
      {
        savedEvidence: {
          assertedPersonFullName: "Ada Lovelace",
          boundCompanyId: "yc-acme",
          boundPersonId: "run-person-123",
          evidenceId: "evidence-source",
          explicitFounder: true,
          source: "USER_CLAIM"
        }
      }
    ],
    ["null current context", null],
    ["non-object saved evidence", { savedEvidence: null }],
    ["missing evidence ID", {
      savedEvidence: {
        assertedPersonFullName: "Ada Lovelace",
        boundCompanyId: "yc-acme",
        boundPersonId: "run-person-123",
        evidenceId: "",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    }],
    ["unsafe nested identity", {
      savedEvidence: {
        assertedPersonFullName: "Ada\u202e Lovelace",
        boundCompanyId: "yc-acme",
        boundPersonId: "run-person-123",
        evidenceId: "evidence-unsafe",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    }],
    ["non-string nested person ID", { currentPersonId: 123 }],
    ["non-string nested company ID", {
      savedEvidence: {
        assertedPersonFullName: "Ada Lovelace",
        boundCompanyId: 7,
        boundPersonId: "run-person-123",
        evidenceId: "evidence-company-type",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    }],
    ["oversized asserted name", {
      savedEvidence: {
        assertedPersonFullName: "a".repeat(513),
        boundCompanyId: "yc-acme",
        boundPersonId: "run-person-123",
        evidenceId: "evidence-large-name",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    }],
    ["oversized evidence ID", {
      savedEvidence: {
        assertedPersonFullName: "Ada Lovelace",
        boundCompanyId: "yc-acme",
        boundPersonId: "run-person-123",
        evidenceId: "e".repeat(129),
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    }]
  ])("rejects plain CEO for %s without throwing", (_name, overrides) => {
    const context = overrides === null
      ? null
      : evidenceContext(overrides as Record<string, unknown>);

    expect(validateFounderRole(
      "CEO",
      context as FounderRoleValidationContext
    )).toEqual({
      ok: false,
      normalizedRole: "CEO",
      reason: "PLAIN_CEO_REQUIRES_SAME_PERSON_FOUNDER_EVIDENCE"
    });
  });

  it("does not let trusted evidence override a negated founder role", () => {
    expect(validateFounderRole(
      "Not a Founder & CEO",
      evidenceContext()
    )).toEqual({
      ok: false,
      normalizedRole: "Not a Founder & CEO",
      reason: "NOT_FOUNDER_ROLE"
    });
  });

  it.each([
    "Non-Founder CEO & Founder at Acme",
    "Not a Founder, CEO & Founder at Acme",
    "Not a Co-Founder & Founder/CEO at Acme"
  ])("rejects contradictory negation even when another component looks explicit: %j", (role) => {
    expect(validateFounderRole(role, evidenceContext())).toEqual({
      ok: false,
      normalizedRole: role,
      reason: "NOT_FOUNDER_ROLE"
    });
  });

  it.each([
    ["Cyrillic confusable", "Fоunder", "NOT_FOUNDER_ROLE"],
    ["full-width confusable", "Ｆｏｕｎｄｅｒ", "NOT_FOUNDER_ROLE"],
    ["zero-width insertion", "Fo\u200bunder", "UNSAFE_ROLE_CHARACTERS"]
  ])("rejects %s text", (_name, role, reason) => {
    expect(validateFounderRole(role)).toMatchObject({
      ok: false,
      reason
    });
  });

  it.each([
    ["tab", "Founder\tCEO"],
    ["newline", "Founder\nCEO"],
    ["zero-width suffix", "Founder\u200b"],
    ["directional override", "Founder\u202e"]
  ])("rejects role input containing a Unicode control: %s", (_name, role) => {
    expect(validateFounderRole(role)).toEqual({
      ok: false,
      reason: "UNSAFE_ROLE_CHARACTERS"
    });
  });

  it("returns safe structured reasons for empty and invalid values", () => {
    expect(validateFounderRole(" \u00a0 ")).toEqual({
      ok: false,
      normalizedRole: "",
      reason: "EMPTY_ROLE"
    });
    expect(validateFounderRole(42 as unknown as string)).toEqual({
      ok: false,
      reason: "INVALID_ROLE_TYPE"
    });
  });

  it("enforces independent character and UTF-8 byte limits without echoing input", () => {
    expect(validateFounderRole(
      `Founder ${"a".repeat(FOUNDER_ROLE_TEXT_LIMITS.characters)}`
    )).toEqual({
      ok: false,
      reason: "ROLE_TOO_LONG"
    });

    expect(validateFounderRole(
      `Founder ${"😀".repeat(FOUNDER_ROLE_TEXT_LIMITS.characters - 8)}`
    )).toEqual({
      ok: false,
      reason: "ROLE_TOO_LARGE"
    });
  });

  it("rejects excessive raw input before normalization and does not echo it", () => {
    expect(validateFounderRole(
      "a".repeat(FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT + 1)
    )).toEqual({
      ok: false,
      reason: "ROLE_TOO_LONG"
    });
  });

  it("exposes a stable discriminated result contract", () => {
    expectTypeOf(validateFounderRole).returns.toEqualTypeOf<FounderRoleValidationResult>();
  });
});
