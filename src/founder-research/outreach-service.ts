import { createHash } from "node:crypto";
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
const PERSON_MARKER = "[[person]]";
const CLAIM_MARKER = "[[claim]]";
const APPROVED_INVITATION_TEMPLATES: ReadonlySet<string> = new Set([
  `hi ${PERSON_MARKER} — i would value connecting.`,
  `hello ${PERSON_MARKER} — i would value connecting.`,
  `hi ${PERSON_MARKER} — i'd love to connect.`,
  `hello ${PERSON_MARKER} — i'd love to connect.`,
  `hi ${PERSON_MARKER} — i work in product marketing and would value connecting.`,
  `hello ${PERSON_MARKER} — i work in product marketing and would value connecting.`,
  `hi ${PERSON_MARKER} — i appreciated ${CLAIM_MARKER}. i'd value connecting.`,
  `hello ${PERSON_MARKER} — i appreciated ${CLAIM_MARKER}. i'd value connecting.`,
  `hi ${PERSON_MARKER} — congratulations on ${CLAIM_MARKER}. i'd value connecting.`,
  `hello ${PERSON_MARKER} — congratulations on ${CLAIM_MARKER}. i'd value connecting.`,
  `hi ${PERSON_MARKER} — i'm interested in ${CLAIM_MARKER} and would value connecting.`,
  `hello ${PERSON_MARKER} — i'm interested in ${CLAIM_MARKER} and would value connecting.`
]);

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
  reviewState?: "READY_TO_REVIEW" | "NEEDS_REVIEW";
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
  reviewState: "READY_TO_REVIEW" | "NEEDS_REVIEW";
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

function templateText(value: string): string {
  return comparable(value).replace(/[’‘]/gu, "'");
}

function matchesApprovedInvitationTemplate(
  text: string,
  personName: string,
  claims: readonly Readonly<{ text: string }> []
): boolean {
  let remaining = templateText(text);
  const person = templateText(personName);
  if (!remaining.includes(person)) return false;
  remaining = remaining.replaceAll(person, PERSON_MARKER);
  for (const claim of claims) {
    const claimText = templateText(claim.text);
    if (!remaining.includes(claimText)) return false;
    remaining = remaining.replaceAll(claimText, CLAIM_MARKER);
  }
  return APPROVED_INVITATION_TEMPLATES.has(remaining);
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
  const reviewState = entry.reviewState ?? "READY_TO_REVIEW";
  if (reviewState !== "READY_TO_REVIEW" && reviewState !== "NEEDS_REVIEW") {
    throw validationError(`entries[${index}].reviewState`, "unsupported_value");
  }
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
    reviewState,
    text: normalizedText(
      `entries[${index}].text`,
      entry.text,
      LINKEDIN_CONNECTION_NOTE_MAX_CODE_POINTS
    )
  };
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function scopedRequestId(
  subject: string,
  personId: string,
  targetId: string,
  requestId: string
): string {
  return canonicalSha256({
    contract: "founder-outreach.request-identity.v1",
    subject,
    personId,
    targetId,
    requestId
  });
}

function payloadHash(runId: string, entry: ValidatedEntry): string {
  const personalizationClaims = entry.personalizationClaims.map(({ text, evidenceIds }) => ({
    text,
    evidenceIds: [...evidenceIds].sort()
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return canonicalSha256({
    contract: "founder-outreach.entry-payload.v1",
    runId,
    personId: entry.personId,
    purpose: LINKEDIN_CONNECTION_REQUEST_PURPOSE,
    pmmOpportunity: entry.pmmOpportunity,
    referralPotential: entry.referralPotential,
    networkValue: entry.networkValue,
    total: entry.total,
    confidence: entry.confidence,
    reasons: [...entry.reasons],
    missingEvidence: [...entry.missingEvidence],
    evidenceIds: [...entry.evidenceIds].sort(),
    personalizationClaims,
    text: entry.text,
    reviewState: entry.reviewState
  });
}

function publicDraft(
  personId: string,
  target: Pick<PipelineTarget, "id">,
  draft: OutreachDraft
): SavedFounderOutreachDraft {
  if (draft.requestId === null || draft.requestPayloadHash === null) {
    throw new DomainError("DATA_INTEGRITY", "Saved founder outreach draft is missing request identity", {
      entity: "outreach_draft"
    });
  }
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

  return Object.freeze({
    async saveBatch(input: SaveFounderOutreachBatchInput): Promise<SaveFounderOutreachBatchResult> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw validationError("input", "must_be_object");
      }
      const runId = normalizedId("runId", input.runId);
      const requestId = normalizedText("requestId", input.requestId, MAX_REQUEST_ID_LENGTH);
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

          const entryPayloadHash = payloadHash(runId, entry);
          const existingTarget = await database.targets.getByPerson(person.id);
          if (existingTarget !== undefined) {
            const existing = await database.outreachDrafts.getByRequest(
              existingTarget.id,
              LINKEDIN_CONNECTION_REQUEST_PURPOSE,
              scopedRequestId(subject, person.id, existingTarget.id, requestId)
            );
            if (existing !== undefined) {
              if (existing.requestPayloadHash !== entryPayloadHash) {
                throw new DomainError("CONFLICT", "Outreach request ID conflicts with saved content", {
                  entity: "outreach_draft"
                });
              }
              drafts.push(publicDraft(person.id, existingTarget, existing));
              continue;
            }
          }

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
            const claimText = comparable(claim.text);
            const claimEvidence = evidence.filter(({ id }) => claim.evidenceIds.includes(id));
            const isSupported = claimEvidence.some(({ title, fact }) => (
              comparable(title ?? "").includes(claimText)
              || comparable(fact).includes(claimText)
            ));
            if (!isSupported || !comparable(entry.text).includes(claimText)) {
              throw evidenceMismatch(`entries[${index}].personalizationClaims`);
            }
          }
          if (!matchesApprovedInvitationTemplate(
            entry.text,
            person.name,
            entry.personalizationClaims
          )) {
            throw evidenceMismatch(`entries[${index}].text`);
          }

          const target = existingTarget ?? await pipeline.saveTarget({
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
          const draft = await database.outreachDrafts.createOrReuseVersion({
            targetId: target.id,
            purpose: LINKEDIN_CONNECTION_REQUEST_PURPOSE,
            text: entry.text,
            evidenceIds: [...entry.evidenceIds],
            requestId: scopedRequestId(subject, person.id, target.id, requestId),
            requestPayloadHash: entryPayloadHash
          });
          drafts.push(publicDraft(person.id, target, draft));
      }

      return frozenResult(drafts, needsVerification);
    }
  });
}
