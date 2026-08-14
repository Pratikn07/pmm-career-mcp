import { DomainError } from "../domain/errors.js";
import type { BrandVisualMode } from "./profile.js";

const CONTROL_PATTERN = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u;
const MODEL_STAGE_NUMBERS = ["01", "02", "03"] as const;

export type EditorialModelStage = Readonly<{
  number: "01" | "02" | "03";
  label: string;
  items: readonly string[];
}>;

export type EditorialModelContent = Readonly<{
  kind: "model";
  subhead: string;
  stages: readonly [
    EditorialModelStage,
    EditorialModelStage,
    EditorialModelStage
  ];
  evidenceLine: string;
}>;

export type EditorialEvidenceSignal = Readonly<{
  label: string;
  detail: string;
}>;

export type EditorialEvidenceContent = Readonly<{
  kind: "evidence";
  subhead: string;
  signals: readonly [
    EditorialEvidenceSignal,
    EditorialEvidenceSignal,
    EditorialEvidenceSignal
  ];
  evidenceLine: string;
}>;

export type BrandVisualContent =
  | EditorialModelContent
  | EditorialEvidenceContent;

function validationError(field: string, reason: string): DomainError {
  return new DomainError(
    "VALIDATION_ERROR",
    "Brand visual content is invalid",
    { field, reason }
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((item, index) => item === canonical[index]);
}

function inlineText(
  value: unknown,
  field: string,
  maximum: number,
  uppercase = false
): string {
  if (typeof value !== "string") {
    throw validationError(field, "type");
  }
  if (CONTROL_PATTERN.test(value)) {
    throw validationError(field, "single_line");
  }
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  const length = [...normalized].length;
  if (length < 1 || length > maximum) {
    throw validationError(field, "character_count");
  }
  return uppercase ? normalized.toLocaleUpperCase("en-US") : normalized;
}

function modelContent(value: unknown): EditorialModelContent {
  const candidate = record(value);
  if (
    candidate === undefined
    || !exactKeys(candidate, ["kind", "subhead", "stages", "evidenceLine"])
    || candidate.kind !== "model"
  ) {
    throw validationError("visualContent", "shape");
  }
  if (!Array.isArray(candidate.stages) || candidate.stages.length !== 3) {
    throw validationError("visualContent.stages", "length");
  }
  const stages = candidate.stages.map((value_, index) => {
    const stage = record(value_);
    const prefix = `visualContent.stages.${index}`;
    if (
      stage === undefined
      || !exactKeys(stage, ["number", "label", "items"])
    ) {
      throw validationError(prefix, "shape");
    }
    if (stage.number !== MODEL_STAGE_NUMBERS[index]) {
      throw validationError(`${prefix}.number`, "sequence");
    }
    if (
      !Array.isArray(stage.items)
      || stage.items.length < 2
      || stage.items.length > 3
    ) {
      throw validationError(`${prefix}.items`, "length");
    }
    return Object.freeze({
      number: MODEL_STAGE_NUMBERS[index]!,
      label: inlineText(stage.label, `${prefix}.label`, 20, true),
      items: Object.freeze(stage.items.map((item, itemIndex) =>
        inlineText(item, `${prefix}.items.${itemIndex}`, 36)
      ))
    });
  }) as [
    EditorialModelStage,
    EditorialModelStage,
    EditorialModelStage
  ];
  return Object.freeze({
    kind: "model",
    subhead: inlineText(candidate.subhead, "visualContent.subhead", 80),
    stages: Object.freeze(stages),
    evidenceLine: inlineText(
      candidate.evidenceLine,
      "visualContent.evidenceLine",
      100
    )
  });
}

function evidenceContent(value: unknown): EditorialEvidenceContent {
  const candidate = record(value);
  if (
    candidate === undefined
    || !exactKeys(candidate, ["kind", "subhead", "signals", "evidenceLine"])
    || candidate.kind !== "evidence"
  ) {
    throw validationError("visualContent", "shape");
  }
  if (!Array.isArray(candidate.signals) || candidate.signals.length !== 3) {
    throw validationError("visualContent.signals", "length");
  }
  const signals = candidate.signals.map((value_, index) => {
    const signal = record(value_);
    const prefix = `visualContent.signals.${index}`;
    if (
      signal === undefined
      || !exactKeys(signal, ["label", "detail"])
    ) {
      throw validationError(prefix, "shape");
    }
    return Object.freeze({
      label: inlineText(signal.label, `${prefix}.label`, 20, true),
      detail: inlineText(signal.detail, `${prefix}.detail`, 72)
    });
  }) as [
    EditorialEvidenceSignal,
    EditorialEvidenceSignal,
    EditorialEvidenceSignal
  ];
  return Object.freeze({
    kind: "evidence",
    subhead: inlineText(candidate.subhead, "visualContent.subhead", 80),
    signals: Object.freeze(signals),
    evidenceLine: inlineText(
      candidate.evidenceLine,
      "visualContent.evidenceLine",
      100
    )
  });
}

export function validateBrandVisualContent(
  mode: BrandVisualMode,
  value: unknown
): BrandVisualContent | undefined {
  if (mode === "EDITORIAL_STATEMENT" || mode === "EDITORIAL_METAPHOR") {
    if (value !== undefined && value !== null) {
      throw validationError("visualContent", "not_allowed");
    }
    return undefined;
  }
  if (value === undefined || value === null) {
    throw validationError("visualContent", "required");
  }
  return mode === "EDITORIAL_MODEL"
    ? modelContent(value)
    : evidenceContent(value);
}
