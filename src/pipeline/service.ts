import type { CareerDatabase } from "../db/client.js";
import type {
  ShortlistEntry,
  ShortlistWithEntries,
  Target,
  TargetNote
} from "../db/repositories.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";
import type { TargetScore } from "../ranking/score-target.js";

const PIPELINE_STATUS_VALUES = [
  "discovered",
  "shortlisted",
  "connect_planned",
  "connected",
  "contacted",
  "replied",
  "archived"
] as const;

export type PipelineStatus = typeof PIPELINE_STATUS_VALUES[number];

const PIPELINE_STATUS_SET: ReadonlySet<string> = new Set(PIPELINE_STATUS_VALUES);

export const PIPELINE_STATUSES: readonly PipelineStatus[] = Object.freeze([
  ...PIPELINE_STATUS_VALUES
]);

const PIPELINE_TRANSITION_VALUES = {
  discovered: ["shortlisted", "archived"],
  shortlisted: ["connect_planned", "archived"],
  connect_planned: ["connected", "archived"],
  connected: ["contacted", "archived"],
  contacted: ["replied", "archived"],
  replied: ["archived"],
  archived: []
} as const satisfies Readonly<Record<PipelineStatus, readonly PipelineStatus[]>>;

const PIPELINE_TRANSITION_SETS: Readonly<Record<PipelineStatus, ReadonlySet<PipelineStatus>>> = {
  discovered: new Set(PIPELINE_TRANSITION_VALUES.discovered),
  shortlisted: new Set(PIPELINE_TRANSITION_VALUES.shortlisted),
  connect_planned: new Set(PIPELINE_TRANSITION_VALUES.connect_planned),
  connected: new Set(PIPELINE_TRANSITION_VALUES.connected),
  contacted: new Set(PIPELINE_TRANSITION_VALUES.contacted),
  replied: new Set(PIPELINE_TRANSITION_VALUES.replied),
  archived: new Set(PIPELINE_TRANSITION_VALUES.archived)
};

/**
 * Pipeline progress is deliberately forward-only. Any active stage may be
 * archived, archived is terminal, and same-status updates are idempotent.
 */
export const PIPELINE_TRANSITIONS: Readonly<Record<PipelineStatus, readonly PipelineStatus[]>> = {
  discovered: Object.freeze([...PIPELINE_TRANSITION_VALUES.discovered]),
  shortlisted: Object.freeze([...PIPELINE_TRANSITION_VALUES.shortlisted]),
  connect_planned: Object.freeze([...PIPELINE_TRANSITION_VALUES.connect_planned]),
  connected: Object.freeze([...PIPELINE_TRANSITION_VALUES.connected]),
  contacted: Object.freeze([...PIPELINE_TRANSITION_VALUES.contacted]),
  replied: Object.freeze([...PIPELINE_TRANSITION_VALUES.replied]),
  archived: Object.freeze([...PIPELINE_TRANSITION_VALUES.archived])
};
Object.freeze(PIPELINE_TRANSITIONS);

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 200;
const MAX_EXPLANATION_ITEMS = 50;
const MAX_EXPLANATION_LENGTH = 500;
const MAX_NOTE_LENGTH = 4_000;
const MAX_SHORTLIST_NAME_LENGTH = 120;
const MAX_SHORTLIST_ENTRIES = 100;

type StoredRationale = {
  version: 1;
  reasons: string[];
  missingEvidence: string[];
};

export type PipelineTarget = Omit<Target, "status" | "rationale"> & {
  status: PipelineStatus;
  reasons: string[];
  missingEvidence: string[];
};

export type SavedTargetNote = TargetNote & { updatedAt: string };

export type PositionedShortlistEntry = {
  targetId: string;
  position: number;
};

export type CreateShortlistInput = {
  name: string;
} & (
  | { entries: readonly PositionedShortlistEntry[]; targetIds?: never }
  | { targetIds: readonly string[]; entries?: never }
);

export type PipelineListFilter = {
  companyId?: string;
  status?: PipelineStatus;
};

function validationError(field: string, reason: string, maximum?: number): DomainError {
  return new DomainError("VALIDATION_ERROR", "Pipeline input is invalid", {
    field,
    reason,
    ...(maximum === undefined ? {} : { maximum })
  });
}

function normalizedText(field: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") {
    throw validationError(field, "must_be_text");
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    throw validationError(field, "must_not_be_empty");
  }
  if ([...normalized].length > maximum) {
    throw validationError(field, "too_long", maximum);
  }
  return normalized;
}

function normalizedId(field: string, value: unknown): string {
  return normalizedText(field, value, MAX_ID_LENGTH);
}

function finiteBoundedNumber(field: string, value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw validationError(field, "out_of_range", maximum);
  }
  return value;
}

function normalizedExplanation(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_EXPLANATION_ITEMS) {
    throw validationError(field, "invalid_collection", MAX_EXPLANATION_ITEMS);
  }
  return value.map((item, index) => normalizedText(
    `${field}[${index}]`,
    item,
    MAX_EXPLANATION_LENGTH
  ));
}

function isPipelineStatus(value: unknown): value is PipelineStatus {
  return typeof value === "string" && PIPELINE_STATUS_SET.has(value);
}

function parseTarget(row: Target): PipelineTarget {
  if (!isPipelineStatus(row.status)) {
    throw new DomainError("DATA_INTEGRITY", "Stored pipeline status is invalid", {
      entity: "target"
    });
  }

  let rationale: StoredRationale;
  try {
    const parsed = JSON.parse(row.rationale) as Partial<StoredRationale>;
    if (
      parsed.version !== 1
      || !Array.isArray(parsed.reasons)
      || !Array.isArray(parsed.missingEvidence)
      || !parsed.reasons.every((item) => typeof item === "string")
      || !parsed.missingEvidence.every((item) => typeof item === "string")
    ) {
      throw new Error("invalid rationale");
    }
    rationale = {
      version: 1,
      reasons: [...parsed.reasons],
      missingEvidence: [...parsed.missingEvidence]
    };
  } catch {
    rationale = {
      version: 1,
      reasons: row.rationale.length === 0 ? [] : [row.rationale],
      missingEvidence: []
    };
  }

  const { rationale: _rationale, status: _status, ...target } = row;
  return {
    ...target,
    status: row.status,
    reasons: rationale.reasons,
    missingEvidence: rationale.missingEvidence
  };
}

function normalizeScore(score: TargetScore): TargetScore {
  if (typeof score !== "object" || score === null) {
    throw validationError("score", "must_be_object");
  }
  const personId = normalizedId("score.personId", score.personId);
  const companyId = normalizedId("score.companyId", score.companyId);
  const companyName = normalizedText("score.companyName", score.companyName, MAX_NAME_LENGTH);
  const name = normalizedText("score.name", score.name, MAX_NAME_LENGTH);
  const pmmOpportunity = finiteBoundedNumber("score.pmmOpportunity", score.pmmOpportunity, 100);
  const referralPotential = finiteBoundedNumber(
    "score.referralPotential",
    score.referralPotential,
    100
  );
  const networkValue = finiteBoundedNumber("score.networkValue", score.networkValue, 100);
  const total = finiteBoundedNumber("score.total", score.total, 100);
  const confidence = finiteBoundedNumber("score.confidence", score.confidence, 1);
  const componentTotal = pmmOpportunity + referralPotential + networkValue;
  if (Math.abs(total - componentTotal) > 1e-9) {
    throw validationError("score.total", "must_equal_component_sum");
  }

  return {
    personId,
    companyId,
    companyName,
    name,
    pmmOpportunity,
    referralPotential,
    networkValue,
    total,
    confidence,
    reasons: normalizedExplanation("score.reasons", score.reasons),
    missingEvidence: normalizedExplanation("score.missingEvidence", score.missingEvidence)
  };
}

function mapPipelinePersistenceError(error: unknown, operation: "target" | "note" | "shortlist"): never {
  const constraint = postgresErrorKind(error);
  if (constraint === "foreign_key") {
    throw new DomainError("NOT_FOUND", "Referenced pipeline record was not found", {
      entity: operation
    });
  }
  if (constraint === "unique") {
    throw new DomainError("CONFLICT", "Pipeline write conflicts with existing data", {
      entity: operation
    });
  }
  if (constraint === "retryable") {
    throw new DomainError("CONFLICT", "Pipeline write could not be completed", {
      entity: operation,
      retryable: true
    });
  }
  throw new DomainError("DATA_INTEGRITY", "Pipeline storage operation failed", {
    entity: operation,
    retryable: false
  });
}

async function withPipelinePersistenceBoundary<T>(
  operation: "target" | "note" | "shortlist",
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    return mapPipelinePersistenceError(error, operation);
  }
}

function normalizeShortlistEntries(input: CreateShortlistInput): PositionedShortlistEntry[] {
  const hasEntries = Object.prototype.hasOwnProperty.call(input, "entries");
  const hasTargetIds = Object.prototype.hasOwnProperty.call(input, "targetIds");
  if (hasEntries === hasTargetIds) {
    throw validationError("shortlist.entries", "choose_one_entry_format");
  }
  if (hasEntries && !Array.isArray(input.entries)) {
    throw validationError("shortlist.entries", "must_be_collection");
  }
  if (hasTargetIds && !Array.isArray(input.targetIds)) {
    throw validationError("shortlist.targetIds", "must_be_collection");
  }

  const positioned = hasEntries
    ? [...(input.entries ?? [])].map((entry) => ({
        targetId: normalizedId("shortlist.entries.targetId", entry?.targetId),
        position: entry?.position
      }))
    : [...(input.targetIds ?? [])].map((targetId, position) => ({
        targetId: normalizedId("shortlist.targetIds", targetId),
        position
      }));
  if (positioned.length > MAX_SHORTLIST_ENTRIES) {
    throw validationError("shortlist.entries", "too_many", MAX_SHORTLIST_ENTRIES);
  }
  for (const entry of positioned) {
    if (!Number.isInteger(entry.position) || entry.position < 0) {
      throw validationError("shortlist.entries.position", "must_be_nonnegative_integer");
    }
  }

  if (new Set(positioned.map((entry) => entry.targetId)).size !== positioned.length) {
    throw new DomainError("CONFLICT", "Shortlist target IDs must be unique", {
      entity: "shortlist_target"
    });
  }
  if (new Set(positioned.map((entry) => entry.position)).size !== positioned.length) {
    throw new DomainError("CONFLICT", "Shortlist positions must be unique", {
      entity: "shortlist_position"
    });
  }

  positioned.sort((left, right) => left.position - right.position);
  if (positioned.some((entry, index) => entry.position !== index)) {
    throw validationError("shortlist.entries.position", "must_be_contiguous_from_zero");
  }
  return positioned;
}

export type PipelineService = ReturnType<typeof createPipelineService>;

export function createPipelineService(database: CareerDatabase) {
  return {
    async saveTarget(input: TargetScore): Promise<PipelineTarget> {
      const score = normalizeScore(input);
      return await withPipelinePersistenceBoundary("target", async () => {
        const person = await database.people.get(score.personId);
        if (person === undefined) {
          throw new DomainError("NOT_FOUND", "Person was not found", { entity: "person" });
        }
        if (
          person.companyId !== score.companyId
          || (await database.companies.get(score.companyId)) === undefined
        ) {
          throw validationError("score.companyId", "does_not_match_person");
        }
        const current = await database.targets.getByPerson(score.personId);
        const status = current === undefined ? "discovered" : parseTarget(current).status;
        const rationale: StoredRationale = {
          version: 1,
          reasons: [...score.reasons],
          missingEvidence: [...score.missingEvidence]
        };

        return parseTarget(await database.targets.upsert({
          personId: score.personId,
          pmmOpportunity: score.pmmOpportunity,
          referralPotential: score.referralPotential,
          networkValue: score.networkValue,
          totalScore: score.total,
          confidence: score.confidence,
          status,
          rationale: JSON.stringify(rationale)
        }));
      });
    },

    async updateStatus(
      targetIdInput: string,
      statusInput: PipelineStatus
    ): Promise<PipelineTarget> {
      const targetId = normalizedId("targetId", targetIdInput);
      if (!isPipelineStatus(statusInput)) {
        throw validationError("status", "unsupported_status");
      }
      return await withPipelinePersistenceBoundary("target", async () => {
        const currentRow = await database.targets.get(targetId);
        if (currentRow === undefined) {
          throw new DomainError("NOT_FOUND", "Target was not found", { entity: "target" });
        }
        const current = parseTarget(currentRow);
        if (current.status === statusInput) {
          return current;
        }
        if (!PIPELINE_TRANSITION_SETS[current.status].has(statusInput)) {
          throw new DomainError(
            "INVALID_TRANSITION",
            "Pipeline status transition is not allowed",
            { from: current.status, to: statusInput }
          );
        }
        const updated = await database.targets.updateStatus(targetId, statusInput);
        if (updated === undefined) {
          throw new DomainError("NOT_FOUND", "Target was not found", { entity: "target" });
        }
        return parseTarget(updated);
      });
    },

    async recordNote(targetIdInput: string, textInput: string): Promise<SavedTargetNote> {
      const targetId = normalizedId("targetId", targetIdInput);
      const text = normalizedText("note.text", textInput, MAX_NOTE_LENGTH);
      return await withPipelinePersistenceBoundary("note", async () => {
        if (await database.targets.get(targetId) === undefined) {
          throw new DomainError("NOT_FOUND", "Target was not found", { entity: "target" });
        }
        const note = await database.notes.add({ targetId, text });
        return { ...note, updatedAt: note.createdAt };
      });
    },

    async listPipeline(filter: PipelineListFilter = {}): Promise<PipelineTarget[]> {
      if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
        throw validationError("filter", "must_be_object");
      }
      const companyId = filter.companyId === undefined
        ? undefined
        : normalizedId("filter.companyId", filter.companyId);
      if (filter.status !== undefined && !isPipelineStatus(filter.status)) {
        throw validationError("filter.status", "unsupported_status");
      }
      return await withPipelinePersistenceBoundary("target", async () => (
        (await database.targets.list({
          ...(companyId === undefined ? {} : { companyId }),
          ...(filter.status === undefined ? {} : { status: filter.status })
        })).map(parseTarget)
      ));
    },

    async createShortlist(input: CreateShortlistInput): Promise<ShortlistWithEntries> {
      if (typeof input !== "object" || input === null) {
        throw validationError("shortlist", "must_be_object");
      }
      const name = normalizedText("shortlist.name", input.name, MAX_SHORTLIST_NAME_LENGTH);
      const entries = normalizeShortlistEntries(input);
      return await withPipelinePersistenceBoundary("shortlist", async () => {
        for (const entry of entries) {
          if (await database.targets.get(entry.targetId) === undefined) {
            throw new DomainError("NOT_FOUND", "Target was not found", { entity: "target" });
          }
        }
        const shortlist = await database.shortlists.create({
          name,
          targetIds: entries.map((entry) => entry.targetId)
        });
        const saved = await database.shortlists.getWithEntries(shortlist.id);
        if (saved === undefined) {
          throw new DomainError("DATA_INTEGRITY", "Saved shortlist could not be loaded", {
            entity: "shortlist"
          });
        }
        return {
          ...saved,
          entries: saved.entries.map((entry: ShortlistEntry) => ({ ...entry }))
        };
      });
    }
  };
}
