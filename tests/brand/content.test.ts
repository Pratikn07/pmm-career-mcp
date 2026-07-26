import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  validateBrandVisualContent
} from "../../src/brand/content.js";

const approvedModel = {
  kind: "model",
  subhead: "What early-stage PMM is starting to look like",
  stages: [
    {
      number: "01",
      label: "Understand",
      items: ["Customer research", "Market intelligence"]
    },
    {
      number: "02",
      label: "Translate",
      items: ["Positioning", "Messaging", "Category narrative"]
    },
    {
      number: "03",
      label: "Execute",
      items: ["Launch", "Enablement", "Experimentation"]
    }
  ],
  evidenceLine: "Observed across selected current YC startup roles"
} as const;

describe("validateBrandVisualContent", () => {
  it("normalizes and freezes the approved three-stage editorial model", () => {
    const content = validateBrandVisualContent(
      "EDITORIAL_MODEL",
      approvedModel
    );

    expect(content).toEqual({
      kind: "model",
      subhead: "What early-stage PMM is starting to look like",
      stages: [
        {
          number: "01",
          label: "UNDERSTAND",
          items: ["Customer research", "Market intelligence"]
        },
        {
          number: "02",
          label: "TRANSLATE",
          items: ["Positioning", "Messaging", "Category narrative"]
        },
        {
          number: "03",
          label: "EXECUTE",
          items: ["Launch", "Enablement", "Experimentation"]
        }
      ],
      evidenceLine: "Observed across selected current YC startup roles"
    });
    expect(content?.kind).toBe("model");
    if (content?.kind !== "model") {
      throw new Error("Expected editorial model content");
    }
    expect(Object.isFrozen(content)).toBe(true);
    expect(Object.isFrozen(content.stages)).toBe(true);
    expect(Object.isFrozen(content.stages[0])).toBe(true);
    expect(Object.isFrozen(content.stages[0].items)).toBe(true);
  });

  it("accepts exactly three concise editorial evidence signals", () => {
    expect(validateBrandVisualContent("EDITORIAL_EVIDENCE", {
      kind: "evidence",
      subhead: "Three hiring signals worth watching",
      signals: [
        { label: "Research", detail: "Customer interviews remain central" },
        { label: "Translation", detail: "Positioning connects insight to action" },
        { label: "Execution", detail: "Launch and enablement sit closer to PMM" }
      ],
      evidenceLine: "Based on selected current public role descriptions"
    })).toMatchObject({
      kind: "evidence",
      signals: [
        { label: "RESEARCH" },
        { label: "TRANSLATION" },
        { label: "EXECUTION" }
      ]
    });
  });

  it.each([
    {
      name: "the model has fewer than three stages",
      value: { ...approvedModel, stages: approvedModel.stages.slice(0, 2) },
      field: "visualContent.stages",
      reason: "length"
    },
    {
      name: "stage numbering is not canonical",
      value: {
        ...approvedModel,
        stages: approvedModel.stages.map((stage, index) => ({
          ...stage,
          number: String(index + 1)
        }))
      },
      field: "visualContent.stages.0.number",
      reason: "sequence"
    },
    {
      name: "a stage has more than three bullets",
      value: {
        ...approvedModel,
        stages: approvedModel.stages.map((stage, index) => index === 0
          ? { ...stage, items: ["One", "Two", "Three", "Four"] }
          : stage)
      },
      field: "visualContent.stages.0.items",
      reason: "length"
    },
    {
      name: "content contains a newline",
      value: {
        ...approvedModel,
        evidenceLine: "Observed across\nselected roles"
      },
      field: "visualContent.evidenceLine",
      reason: "single_line"
    }
  ])("rejects model content when $name", ({ value, field, reason }) => {
    expect(() => validateBrandVisualContent("EDITORIAL_MODEL", value))
      .toThrowError(expect.objectContaining<Partial<DomainError>>({
        code: "VALIDATION_ERROR",
        details: { field, reason }
      }));
  });

  it.each([
    ["EDITORIAL_STATEMENT", approvedModel],
    ["EDITORIAL_METAPHOR", approvedModel]
  ] as const)("rejects structured content for %s", (mode, value) => {
    expect(() => validateBrandVisualContent(mode, value))
      .toThrowError(expect.objectContaining<Partial<DomainError>>({
        code: "VALIDATION_ERROR",
        details: {
          field: "visualContent",
          reason: "not_allowed"
        }
      }));
  });

  it.each([
    "EDITORIAL_MODEL",
    "EDITORIAL_EVIDENCE"
  ] as const)("requires structured content for %s", (mode) => {
    expect(() => validateBrandVisualContent(mode, undefined))
      .toThrowError(expect.objectContaining<Partial<DomainError>>({
        code: "VALIDATION_ERROR",
        details: {
          field: "visualContent",
          reason: "required"
        }
      }));
  });
});
