import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT,
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
      role: " \u2002Co-Founder\u00a0&  Cafe\u0301 Lead "
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
    "Founder Relations Manager",
    "Non-Founder CEO",
    "Not a Founder",
    "Advisor to the Founder",
    "Cofounder Relations Manager",
    "Cofounder's Associate",
    "Advisor to a Co-Founder",
    "Assistant to the Founding CEO"
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
    "accepts plain %s only with verifiable normalized same-person founder evidence",
    (role) => {
      expect(validateFounderRole({
        role,
        samePersonFounderEvidence: {
          bindingKind: "NORMALIZED_IDENTITY",
          assertedPersonIdentity: "Ada Lovelace",
          expectedPersonIdentity: "Ada Lovelace",
          companyId: "yc-acme",
          evidenceId: "evidence-1",
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
          bindingKind: "NORMALIZED_IDENTITY",
          assertedPersonIdentity: "Grace Hopper",
          expectedPersonIdentity: "Grace Hopper",
          companyId: "yc-acme",
          evidenceId: "evidence-2",
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
        bindingKind: "NORMALIZED_IDENTITY",
        assertedPersonIdentity: "Ada Lovelace",
        expectedPersonIdentity: "Ada Lovelace",
        companyId: "yc-acme",
        evidenceId: "evidence-3",
        explicitFounder: false,
        source: "OFFICIAL_YC"
      }
    })).toEqual({
      ok: false,
      normalizedRole: "CEO",
      reason: "PLAIN_CEO_REQUIRES_SAME_PERSON_FOUNDER_EVIDENCE"
    });
  });

  it("does not let same-person evidence override an explicitly negated founder role", () => {
    expect(validateFounderRole({
      role: "Not a Founder & CEO",
      samePersonFounderEvidence: {
        bindingKind: "NORMALIZED_IDENTITY",
        assertedPersonIdentity: "Ada Lovelace",
        expectedPersonIdentity: "Ada Lovelace",
        companyId: "yc-acme",
        evidenceId: "evidence-negated",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    })).toEqual({
      ok: false,
      normalizedRole: "Not a Founder & CEO",
      reason: "NOT_FOUNDER_ROLE"
    });
  });

  it("accepts an exact stable run-person binding", () => {
    expect(validateFounderRole({
      role: "CEO",
      samePersonFounderEvidence: {
        bindingKind: "RUN_PERSON_ID",
        assertedRunPersonId: "run-person-123",
        expectedRunPersonId: "run-person-123",
        companyId: "yc-acme",
        evidenceId: "evidence-4",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    })).toEqual({
      ok: true,
      basis: "SAME_PERSON_FOUNDER_EVIDENCE",
      normalizedRole: "CEO"
    });
  });

  it.each([
    [
      "mismatched normalized identities",
      {
        bindingKind: "NORMALIZED_IDENTITY",
        assertedPersonIdentity: "Ada Lovelace",
        expectedPersonIdentity: "Grace Hopper",
        companyId: "yc-acme",
        evidenceId: "evidence-5",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    ],
    [
      "mismatched run-person IDs",
      {
        bindingKind: "RUN_PERSON_ID",
        assertedRunPersonId: "run-person-123",
        expectedRunPersonId: "run-person-456",
        companyId: "yc-acme",
        evidenceId: "evidence-6",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    ],
    [
      "missing company context",
      {
        bindingKind: "NORMALIZED_IDENTITY",
        assertedPersonIdentity: "Ada Lovelace",
        expectedPersonIdentity: "Ada Lovelace",
        companyId: "",
        evidenceId: "evidence-7",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    ],
    [
      "missing saved evidence identifier",
      {
        bindingKind: "NORMALIZED_IDENTITY",
        assertedPersonIdentity: "Ada Lovelace",
        expectedPersonIdentity: "Ada Lovelace",
        companyId: "yc-acme",
        evidenceId: "",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    ],
    [
      "unsafe asserted identity",
      {
        bindingKind: "NORMALIZED_IDENTITY",
        assertedPersonIdentity: "Ada\u202e Lovelace",
        expectedPersonIdentity: "Ada Lovelace",
        companyId: "yc-acme",
        evidenceId: "evidence-8",
        explicitFounder: true,
        source: "OFFICIAL_YC"
      }
    ],
    [
      "unknown evidence source",
      {
        bindingKind: "NORMALIZED_IDENTITY",
        assertedPersonIdentity: "Ada Lovelace",
        expectedPersonIdentity: "Ada Lovelace",
        companyId: "yc-acme",
        evidenceId: "evidence-9",
        explicitFounder: true,
        source: "USER_CLAIM"
      }
    ],
    [
      "non-object evidence",
      null
    ]
  ])("rejects CEO evidence with %s", (_name, samePersonFounderEvidence) => {
    expect(validateFounderRole({
      role: "CEO",
      samePersonFounderEvidence: samePersonFounderEvidence as never
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
    ["tab", "Founder\tCEO"],
    ["newline", "Founder\nCEO"],
    ["zero-width suffix", "Founder\u200b"],
    ["directional override", "Founder\u202e"]
  ])("rejects an explicit role containing a Unicode format control: %s", (_name, role) => {
    expect(validateFounderRole({ role })).toEqual({
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
    })).toEqual({
      ok: false,
      reason: "ROLE_TOO_LONG"
    });

    expect(validateFounderRole({
      role: `Founder ${"😀".repeat(FOUNDER_ROLE_TEXT_LIMITS.characters - 8)}`
    })).toEqual({
      ok: false,
      reason: "ROLE_TOO_LARGE"
    });
  });

  it("rejects an excessive raw input before normalization and does not echo it", () => {
    expect(validateFounderRole({
      role: "a".repeat(FOUNDER_ROLE_RAW_CODE_UNIT_LIMIT + 1)
    })).toEqual({
      ok: false,
      reason: "ROLE_TOO_LONG"
    });
  });

  it("exposes a stable discriminated result contract", () => {
    expectTypeOf(validateFounderRole).returns.toEqualTypeOf<FounderRoleValidationResult>();
  });
});
