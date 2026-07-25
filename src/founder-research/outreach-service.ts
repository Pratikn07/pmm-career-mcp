import type { CareerDatabase } from "../db/client.js";
import type { OutreachDraft } from "../db/repositories.js";
import { DomainError } from "../domain/errors.js";
import { createPipelineService, type PipelineTarget } from "../pipeline/service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_BATCH_ENTRIES = 25;
const MAX_REQUEST_ID_LENGTH = 200;
const MAX_CLAIM_LENGTH = 500;
const MAX_CLAIMS_PER_ENTRY = 25;
const MAX_EVIDENCE_IDS = 25;

export const LINKEDIN_CONNECTION_NOTE_MAX_CODE_POINTS = 200;
export const LINKEDIN_CONNECTION_REQUEST_PURPOSE = "linkedin_connection_request";

export type FounderOutreachPersonalizationClaim = Readonly<{
  text: string;
  evidenceIds: readonly string[];
}>;

export type FounderOutreachBatchEntry = Readonly<{
  personId: string;
  pmmOpportunity: number;
  referralPotential: number;
  networkValue: number;
  total: number;
  confidence: number;
  reasons: readonly string[];
  missingEvidence: readonly string[];
  evidenceIds: readonly string[];
  personalizationClaims: readonly FounderOutreachPersonalizationClaim[];
  text: string;
}>;

export type SaveFounderOutreachBatchInput = Readonly<{
  runId: string;
  requestId: string;
  entries: readonly FounderOutreachBatchEntry[];
}>;

export type SavedFounderOutreachDraft = Readonly<{
  personId: string;
  targetId: string;
  draftId: string;
  version: number;
  purpose: typeof LINKEDIN_CONNECTION_REQUEST_PURPOSE;
  text: string;
  evidenceIds: readonly string[];
}>;

export type FounderOutreachNeedsVerification = Readonly<{
  personId: string;
  reason: "PROFILE_NOT_CONFIRMED";
}>;

export type SaveFounderOutreachBatchResult = Readonly<{
  drafts: readonly SavedFounderOutreachDraft[];
  needsVerification: readonly FounderOutreachNeedsVerification[];
}>;

type ValidatedEntry = FounderOutreachBatchEntry & Readonly<{
  text: string;
  evidenceIds: readonly string[];
  personalizationClaims: readonly Readonly<{
    text: string;
    evidenceIds: readonly string[];
  }>[];
}>;

function validationError(field: string, reason: string, maximum?: number): DomainError {
  return new DomainError("VALIDATION_ERROR", "Founder outreach batch input is invalid", {
    field,
    reason,
    ...(maximum === undefined ? {} : { maximum })
  });
}

function notFound(entity: "founder_research_run" | "founder_research_person"): DomainError {
  return new DomainError("NOT_FOUND", "Founder outreach context was not found", { entity });
}

function evidenceMismatch(field: string): DomainError {
  return new DomainError(
    "EVIDENCE_MISMATCH",
    "Outreach personalization is not supported by the selected person's evidence",
    { field }
  );
}

function normalizedText(field: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") {
    throw validationError(field, "must_be_text", maximum);
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    throw validationError(field, "must_not_be_empty", maximum);
  }
  if (Array.from(normalized).length > maximum) {
    throw validationError(field, "too_long", maximum);
  }
  return normalized;
}

function normalizedId(field: string, value: unknown): string {
  const normalized = normalizedText(field, value, 256);
  if (!UUID_PATTERN.test(normalized)) {
    throw validationError(field, "must_be_uuid");
  }
  return normalized.toLowerCase();
}

function normalizedEvidenceIds(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) {
    throw validationError(field, "invalid_collection", MAX_EVIDENCE_IDS);
  }
  const ids = value.map((entry, index) => normalizedId(`${field}[${index}]`, entry));
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("CONFLICT", "Outreach evidence IDs must be unique", { field });
  }
  return ids;
}

function comparable(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function validatedEntry(value: unknown, index: number): ValidatedEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`entries[${index}]`, "must_be_object");
  }
  const entry = value as Partial<FounderOutreachBatchEntry>;
  const evidenceIds = normalizedEvidenceIds(`entries[${index}].evidenceIds`, entry.evidenceIds);
  if (!Array.isArray(entry.personalizationClaims) || entry.personalizationClaims.length > MAX_CLAIMS_PER_ENTRY) {
    throw validationError(
      `entries[${index}].personalizationClaims`,
      "invalid_collection",
      MAX_CLAIMS_PER_ENTRY
    );
  }
  const claims = entry.personalizationClaims.map((claim, claimIndex) => {
    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
      throw validationError(`entries[${index}].personalizationClaims[${claimIndex}]`, "must_be_object");
    }
    const record = claim as Partial<FounderOutreachPersonalizationClaim>;
    const claimEvidenceIds = normalizedEvidenceIds(
      `entries[${index}].personalizationClaims[${claimIndex}].evidenceIds`,
      record.evidenceIds
    );
    if (claimEvidenceIds.length === 0) {
      throw evidenceMismatch(`entries[${index}].personalizationClaims[${claimIndex}]`);
    }
    return {
      text: normalizedText(
        `entries[${index}].personalizationClaims[${claimIndex}].text`,
        record.text,
        MAX_CLAIM_LENGTH
      ),
      evidenceIds: claimEvidenceIds
    };
  });
  return {
    personId: normalizedId(`entries[${index}].personId`, entry.personId),
    pmmOpportunity: entry.pmmOpportunity as number,
    referralPotential: entry.referralPotential as number,
    networkValue: entry.networkValue as number,
    total: entry.total as number,
    confidence: entry.confidence as number,
    reasons: entry.reasons ?? [],
    missingEvidence: entry.missingEvidence ?? [],
    evidenceIds,
    personalizationClaims: claims,
    text: normalizedText(
      `entries[${index}].text`,
      entry.text,
      LINKEDIN_CONNECTION_NOTE_MAX_CODE_POINTS
    )
  };
}

function publicDraft(
  personId: string,
  target: Pick<PipelineTarget, "id">,
  draft: OutreachDraft
): SavedFounderOutreachDraft {
  return Object.freeze({
    personId,
    targetId: target.id,
    draftId: draft.id,
    version: draft.version,
    purpose: LINKEDIN_CONNECTION_REQUEST_PURPOSE,
    text: draft.text,
    evidenceIds: Object.freeze([...draft.evidenceIds])
  });
}

function isSameSavedDraft(draft: OutreachDraft, entry: ValidatedEntry): boolean {
  return draft.purpose === LINKEDIN_CONNECTION_REQUEST_PURPOSE
    && draft.text === entry.text
    && draft.evidenceIds.length === entry.evidenceIds.length
    && draft.evidenceIds.every((evidenceId, index) => evidenceId === entry.evidenceIds[index]);
}

function frozenResult(
  drafts: readonly SavedFounderOutreachDraft[],
  needsVerification: readonly FounderOutreachNeedsVerification[]
): SaveFounderOutreachBatchResult {
  return Object.freeze({
    drafts: Object.freeze([...drafts]),
    needsVerification: Object.freeze([...needsVerification])
  });
}

export type FounderOutreachService = ReturnType<typeof createFounderOutreachService>;

export function createFounderOutreachService(
  database: CareerDatabase,
  dependencies: Readonly<{ subject: string }>
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  const subject = dependencies.subject.toLowerCase();
  const pipeline = createPipelineService(database);
  const completedRequests = new Map<string, SaveFounderOutreachBatchResult>();

  return Object.freeze({
    async saveBatch(input: SaveFounderOutreachBatchInput): Promise<SaveFounderOutreachBatchResult> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw validationError("input", "must_be_object");
      }
      const runId = normalizedId("runId", input.runId);
      const requestId = normalizedText("requestId", input.requestId, MAX_REQUEST_ID_LENGTH);
      const idempotencyKey = `${runId}\u0000${requestId}`;
      const existing = completedRequests.get(idempotencyKey);
      if (existing !== undefined) return existing;
      if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > MAX_BATCH_ENTRIES) {
        throw validationError("entries", "invalid_collection", MAX_BATCH_ENTRIES);
      }
      const entries = input.entries.map(validatedEntry);
      if (new Set(entries.map(({ personId }) => personId)).size !== entries.length) {
        throw new DomainError("CONFLICT", "A batch may include a person only once", { entity: "person" });
      }
      if ((await database.founderResearchRuns.getOwned(runId, subject)) === undefined) {
        throw notFound("founder_research_run");
      }
      const runPeople = new Map((await database.founderResearchPeople.listForRun(runId, subject)).map(
        (runPerson) => [runPerson.personId, runPerson] as const
      ));
      const drafts: SavedFounderOutreachDraft[] = [];
      const needsVerification: FounderOutreachNeedsVerification[] = [];

      for (const [index, entry] of entries.entries()) {
        const runPerson = runPeople.get(entry.personId);
        if (runPerson === undefined) throw notFound("founder_research_person");
        const canonical = await database.founderProfileCandidates.getCanonicalForPerson(
          runPerson.id,
          subject
        );
        if (
          (runPerson.identityStatus !== "VERIFIED" && runPerson.identityStatus !== "CONFIRMED")
          || canonical === undefined
          || (canonical.status !== "VERIFIED" && canonical.status !== "CONFIRMED")
        ) {
          needsVerification.push(Object.freeze({
            personId: entry.personId,
            reason: "PROFILE_NOT_CONFIRMED"
          }));
          continue;
        }
        const person = await database.people.get(entry.personId);
        if (person === undefined) throw notFound("founder_research_person");
        const company = await database.companies.get(person.companyId);
        if (company === undefined) throw notFound("founder_research_person");

        const evidence = await Promise.all(entry.evidenceIds.map(async (evidenceId) => {
          const row = await database.evidence.get(evidenceId);
          if (row === undefined || row.personId !== person.id) {
            throw evidenceMismatch(`entries[${index}].evidenceIds`);
          }
          return row;
        }));
        for (const claim of entry.personalizationClaims) {
          if (claim.evidenceIds.some((id) => !entry.evidenceIds.includes(id))) {
            throw evidenceMismatch(`entries[${index}].personalizationClaims`);
          }
          const claimEvidence = evidence.filter(({ id }) => claim.evidenceIds.includes(id));
          const sourceText = claimEvidence.map(({ title, fact }) => `${title ?? ""}\n${fact}`).join("\n");
          if (!comparable(sourceText).includes(comparable(claim.text))) {
            throw evidenceMismatch(`entries[${index}].personalizationClaims`);
          }
        }

        const existingTarget = await database.targets.getByPerson(person.id);
        const latest = existingTarget === undefined
          ? undefined
          : (await database.outreachDrafts.listForTarget(existingTarget.id))
            .filter(({ purpose }) => purpose === LINKEDIN_CONNECTION_REQUEST_PURPOSE)
            .at(-1);
        if (
          existingTarget !== undefined
          && latest !== undefined
          && isSameSavedDraft(latest, entry)
        ) {
          drafts.push(publicDraft(person.id, existingTarget, latest));
          continue;
        }
        const target = await pipeline.saveTarget({
          personId: person.id,
          companyId: company.id,
          companyName: company.name,
          name: person.name,
          pmmOpportunity: entry.pmmOpportunity,
          referralPotential: entry.referralPotential,
          networkValue: entry.networkValue,
          total: entry.total,
          confidence: entry.confidence,
          reasons: [...entry.reasons],
          missingEvidence: [...entry.missingEvidence]
        });
        const draft = await database.outreachDrafts.createVersion({
          targetId: target.id,
          purpose: LINKEDIN_CONNECTION_REQUEST_PURPOSE,
          text: entry.text,
          evidenceIds: [...entry.evidenceIds]
        });
        drafts.push(publicDraft(person.id, target, draft));
      }

      const result = frozenResult(drafts, needsVerification);
      completedRequests.set(idempotencyKey, result);
      return result;
    }
  });
}
