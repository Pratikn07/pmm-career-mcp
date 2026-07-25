import type { CareerDatabase } from "../db/client.js";
import type {
  Company,
  FounderProfileCandidate,
  PersonWithEvidence
} from "../db/repositories.js";
import { DomainError, postgresErrorKind } from "../domain/errors.js";
import {
  validateSourceTimestamp
} from "../research/source-validation.js";
import {
  FOUNDER_ROLE_TEXT_LIMITS,
  validateFounderRole
} from "./founder-role.js";
import { validateNonFetchingLinkedInProfileUrl } from "./profile-url.js";
import type { FounderRoleValidationContext } from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNSAFE_CONTROL = /[\p{Cc}\p{Cf}]/u;
const NAME_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\p{Pd}-]*/gu;
const WHITESPACE = /\s+/gu;
const EVIDENCE_CLAUSE_BOUNDARY =
  /(?:\s+[|·•-]\s+)|[|·•—–,;:!?()[\]{}]|\.(?:\s+|$)/gu;
const COMPANY_LEGAL_SUFFIXES = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "ltd",
  "plc"
]);
const COMPANY_INTRODUCERS = new Set([
  "at",
  "for",
  "from",
  "of",
  "organization",
  "startup",
  "team",
  "with"
]);

export const CANDIDATE_FIELD_LIMITS = Object.freeze({
  founderName: Object.freeze({ characters: 200, bytes: 512 }),
  founderRole: Object.freeze({ ...FOUNDER_ROLE_TEXT_LIMITS }),
  searchQuery: Object.freeze({ characters: 500, bytes: 2_000 }),
  resultTitle: Object.freeze({ characters: 512, bytes: 1_024 }),
  resultSnippet: Object.freeze({ characters: 2_000, bytes: 4_000 }),
  decisionNote: Object.freeze({ characters: 1_000, bytes: 2_000 })
});

export type SaveFounderProfileCandidateInput = Readonly<{
  runId: string;
  runItemId: string;
  runPersonId: string;
  founderName: string;
  founderRole: string;
  candidateProfileUrl: string;
  searchQuery: string;
  resultUrl: string;
  resultTitle?: string;
  resultSnippet?: string;
  checkedAt: string;
  confidence: number;
  linkedInNotFetched: true;
}>;

export type FounderProfileCandidateDecisionInput = Readonly<{
  candidateId: string;
  decision: "CONFIRM" | "REJECT";
  note?: string;
}>;

export type FounderCandidateResult = Readonly<{
  candidate: FounderProfileCandidate;
  canonical: FounderProfileCandidate | undefined;
  requiresManualReview: boolean;
}>;

export type FounderCandidateService = Readonly<{
  saveCandidate(
    input: SaveFounderProfileCandidateInput
  ): Promise<FounderCandidateResult>;
  decideCandidate(
    input: FounderProfileCandidateDecisionInput
  ): Promise<FounderCandidateResult>;
}>;

type StringLimits = Readonly<{
  characters: number;
  bytes: number;
}>;

function validationError(
  field: string,
  reason: string,
  limits?: StringLimits
): DomainError {
  return new DomainError(
    "VALIDATION_ERROR",
    "Founder profile candidate input is invalid",
    {
      field,
      reason,
      ...(limits === undefined
        ? {}
        : {
            maximumCharacters: limits.characters,
            maximumBytes: limits.bytes
          })
    }
  );
}

function evidenceMismatch(field: string, reason: string): DomainError {
  return new DomainError(
    "EVIDENCE_MISMATCH",
    "Public-search evidence does not match the candidate",
    { field, reason }
  );
}

function notFound(): DomainError {
  return new DomainError(
    "NOT_FOUND",
    "Founder research person was not found",
    { entity: "founder_research_person" }
  );
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function validateBoundedString(
  field: string,
  value: unknown,
  limits: StringLimits,
  options: { optional?: boolean } = {}
): string | undefined {
  if (value === undefined && options.optional === true) {
    return undefined;
  }
  if (
    typeof value !== "string"
    || value === ""
    || value.trim() === ""
  ) {
    throw validationError(field, "required", limits);
  }
  if (UNSAFE_CONTROL.test(value)) {
    throw validationError(field, "unsafe_characters", limits);
  }
  if (countCodePoints(value) > limits.characters) {
    throw validationError(field, "character_count", limits);
  }
  if (Buffer.byteLength(value, "utf8") > limits.bytes) {
    throw validationError(field, "byte_count", limits);
  }
  return value;
}

function normalizeWhitespace(value: string): string {
  return value.normalize("NFC").replace(WHITESPACE, " ").trim();
}

function normalizedComparableText(value: string): string {
  return normalizeWhitespace(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(WHITESPACE, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedNameSignature(value: string): string | undefined {
  const normalized = normalizeWhitespace(value).toLocaleLowerCase("en-US");
  const tokens = normalized.match(NAME_TOKEN);
  if (
    tokens === null
    || tokens.length < 2
    || tokens.some((token) => {
      const letters = token.match(/\p{L}/gu);
      return letters === null || letters.length < 2;
    })
  ) {
    return undefined;
  }
  return [...tokens].sort().join("\u0000");
}

function comparableTokens(value: string): string[] {
  const normalized = normalizedComparableText(value);
  return normalized === "" ? [] : normalized.split(" ");
}

function containsContiguousTokenPermutation(
  actualTokens: readonly string[],
  expectedTokens: readonly string[]
): boolean {
  if (expectedTokens.length === 0 || actualTokens.length < expectedTokens.length) {
    return false;
  }
  const expectedSignature = [...expectedTokens].sort().join("\u0000");
  for (
    let start = 0;
    start <= actualTokens.length - expectedTokens.length;
    start += 1
  ) {
    const windowSignature = actualTokens
      .slice(start, start + expectedTokens.length)
      .sort()
      .join("\u0000");
    if (windowSignature === expectedSignature) {
      return true;
    }
  }
  return false;
}

function companyIdentityTokens(value: string): string[] {
  const allTokens = comparableTokens(value);
  const identityTokens = [...allTokens];
  while (
    identityTokens.length > 0
    && COMPANY_LEGAL_SUFFIXES.has(identityTokens[identityTokens.length - 1]!)
  ) {
    identityTokens.pop();
  }
  return identityTokens.length === 0 ? allTokens : identityTokens;
}

function evidenceTokenClauses(field: string): string[][] {
  return field.normalize("NFC")
    .split(EVIDENCE_CLAUSE_BOUNDARY)
    .map(comparableTokens)
    .filter(({ length }) => length > 0);
}

function containsBoundedCompanyIdentity(
  field: string,
  expectedTokens: readonly string[]
): boolean {
  if (expectedTokens.length === 0) {
    return false;
  }
  return evidenceTokenClauses(field).some((tokens) => {
    for (
      let start = 0;
      start <= tokens.length - expectedTokens.length;
      start += 1
    ) {
      if (
        expectedTokens.some(
          (expected, offset) => tokens[start + offset] !== expected
        )
      ) {
        continue;
      }
      if (
        start > 0
        && !COMPANY_INTRODUCERS.has(tokens[start - 1]!)
      ) {
        continue;
      }
      const remaining = tokens.slice(start + expectedTokens.length);
      if (remaining.every((token) => COMPANY_LEGAL_SUFFIXES.has(token))) {
        return true;
      }
    }
    return false;
  });
}

function matchResultField(
  field: string | undefined,
  founderTokens: readonly string[],
  companyTokens: readonly string[]
): {
  founder: boolean;
  company: boolean;
  bound: boolean;
} {
  if (field === undefined) {
    return { founder: false, company: false, bound: false };
  }
  const founder = evidenceTokenClauses(field).some(
    (clause) => containsContiguousTokenPermutation(clause, founderTokens)
  );
  const company = containsBoundedCompanyIdentity(field, companyTokens);
  return { founder, company, bound: founder && company };
}

function canonicalStatusRank(status: FounderProfileCandidate["status"]): number {
  switch (status) {
    case "CONFIRMED":
      return 0;
    case "VERIFIED":
      return 1;
    default:
      return 2;
  }
}

function deriveCandidateState(
  candidates: readonly FounderProfileCandidate[]
): {
  canonical: FounderProfileCandidate | undefined;
  requiresManualReview: boolean;
} {
  const canonical = candidates
    .filter(({ status }) => status === "CONFIRMED" || status === "VERIFIED")
    .sort((left, right) => (
      canonicalStatusRank(left.status) - canonicalStatusRank(right.status)
      || right.checkedAt.localeCompare(left.checkedAt)
      || left.id.localeCompare(right.id)
    ))[0];
  return {
    canonical,
    requiresManualReview: candidates.some(
      ({ status }) => status === "CANDIDATE"
    )
  };
}

function validateUuid(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw validationError(field, "must_be_uuid");
  }
  return value.toLowerCase();
}

function safeYcEvidenceSource(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (
        hostname === "ycombinator.com"
        || hostname.endsWith(".ycombinator.com")
      );
  } catch {
    return false;
  }
}

function currentFounderRoleContext(
  person: PersonWithEvidence,
  now: Date
): FounderRoleValidationContext | undefined {
  for (const saved of person.evidence) {
    if (saved.factType !== "public_role") {
      continue;
    }
    const explicitRole = validateFounderRole(saved.fact);
    if (!explicitRole.ok || explicitRole.basis !== "EXPLICIT_FOUNDER_ROLE") {
      continue;
    }
    try {
      if (validateSourceTimestamp(saved.checkedAt, now, "saved founder evidence").stale) {
        continue;
      }
    } catch {
      continue;
    }
    return {
      currentCompanyId: person.companyId,
      currentPersonId: person.id,
      currentPersonName: person.name,
      savedEvidence: {
        assertedPersonFullName: person.name,
        boundCompanyId: person.companyId,
        boundPersonId: person.id,
        evidenceId: saved.id,
        explicitFounder: true,
        source: safeYcEvidenceSource(saved.sourceUrl)
          ? "OFFICIAL_YC"
          : "SAVED_PUBLIC_EVIDENCE"
      }
    };
  }
  return undefined;
}

function mapPersistenceError(
  error: unknown,
  operation: "read" | "write"
): never {
  if (error instanceof DomainError) {
    throw error;
  }
  const message = operation === "read"
    ? "Founder profile candidate data could not be read"
    : "Founder profile candidate could not be saved";
  switch (postgresErrorKind(error)) {
    case "foreign_key":
      throw notFound();
    case "unique":
    case "retryable":
      throw new DomainError(
        "CONFLICT",
        message,
        { entity: "founder_profile_candidate" }
      );
    default:
      throw new DomainError(
        "DATA_INTEGRITY",
        message,
        { entity: "founder_profile_candidate" }
      );
  }
}

async function withPersistenceMapping<T>(
  operation: "read" | "write",
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    mapPersistenceError(error, operation);
  }
}

function validateCandidateUrls(
  candidateProfileUrl: unknown,
  resultUrl: unknown
): {
  normalizedProfileUrl: string;
  exactResultUrl: string;
} {
  if (typeof candidateProfileUrl !== "string") {
    throw validationError("candidateProfileUrl", "invalid_url");
  }
  const profile = validateNonFetchingLinkedInProfileUrl(candidateProfileUrl);
  if (!profile.ok) {
    throw validationError("candidateProfileUrl", profile.reason);
  }
  if (typeof resultUrl !== "string") {
    throw validationError("resultUrl", "invalid_url");
  }
  const result = validateNonFetchingLinkedInProfileUrl(resultUrl);
  if (!result.ok) {
    throw validationError("resultUrl", result.reason);
  }
  if (profile.value !== result.value) {
    throw evidenceMismatch("resultUrl", "candidate_url_mismatch");
  }
  return {
    normalizedProfileUrl: profile.value,
    exactResultUrl: resultUrl
  };
}

function validateCheckedAt(value: unknown, now: Date): string {
  if (typeof value !== "string") {
    throw validationError("checkedAt", "invalid_timestamp");
  }
  try {
    const result = validateSourceTimestamp(value, now, "public-search evidence");
    if (result.stale) {
      throw new DomainError(
        "EVIDENCE_MISMATCH",
        "Public-search evidence is stale",
        { field: "checkedAt", reason: "stale" }
      );
    }
    return result.checkedAt;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw validationError("checkedAt", "invalid_or_future_timestamp");
  }
}

function validateConfidence(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw validationError("confidence", "must_be_between_zero_and_one");
  }
  return value;
}

function validateNotFetched(value: unknown): void {
  if (value !== true) {
    throw validationError("linkedInNotFetched", "must_be_true");
  }
}

function trustedNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError(
      "DATA_INTEGRITY",
      "Founder candidate clock is invalid",
      { entity: "founder_candidate_clock" }
    );
  }
  return value;
}

function validateDecision(
  input: FounderProfileCandidateDecisionInput
): {
  candidateId: string;
  decision: "CONFIRM" | "REJECT";
  note?: string;
} {
  const candidateId = validateUuid("candidateId", input.candidateId);
  if (input.decision !== "CONFIRM" && input.decision !== "REJECT") {
    throw validationError("decision", "unsupported");
  }
  const note = validateBoundedString(
    "note",
    input.note,
    CANDIDATE_FIELD_LIMITS.decisionNote,
    { optional: true }
  );
  return {
    candidateId,
    decision: input.decision,
    ...(note === undefined ? {} : { note })
  };
}

export function createFounderCandidateService(
  database: CareerDatabase,
  dependencies: {
    subject: string;
    now?: () => Date;
  }
): FounderCandidateService {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError(
      "AUTH_REQUIRED",
      "Authenticated request identity is required"
    );
  }
  const subject = dependencies.subject.toLowerCase();
  const now = dependencies.now ?? (() => new Date());

  async function loadOwnedContext(input: {
    runId: string;
    runItemId: string;
    runPersonId: string;
  }): Promise<{
    company: Company;
    person: PersonWithEvidence;
    runPerson: Awaited<
      ReturnType<CareerDatabase["founderResearchPeople"]["listForRun"]>
    >[number];
  }> {
    const runId = validateUuid("runId", input.runId);
    const runItemId = validateUuid("runItemId", input.runItemId);
    const runPersonId = validateUuid("runPersonId", input.runPersonId);
    return await withPersistenceMapping("read", async () => {
      const run = await database.founderResearchRuns.getOwned(runId, subject);
      if (run === undefined) {
        throw notFound();
      }
      const runPeople = await database.founderResearchPeople.listForRun(run.id, subject);
      const runPerson = runPeople.find((item) => (
        item.id === runPersonId && item.runItemId === runItemId
      ));
      if (runPerson === undefined) {
        throw notFound();
      }
      const person = await database.people.getWithEvidence(runPerson.personId);
      if (person === undefined) {
        throw notFound();
      }
      const company = await database.companies.get(person.companyId);
      if (company === undefined) {
        throw notFound();
      }
      return { company, person, runPerson };
    });
  }

  async function loadCandidateState(runPersonId: string): Promise<{
    canonical: FounderProfileCandidate | undefined;
    requiresManualReview: boolean;
  }> {
    return await withPersistenceMapping("read", async () => {
      const candidates = await database.founderProfileCandidates.listForPerson(
        runPersonId,
        subject
      );
      return deriveCandidateState(candidates);
    });
  }

  return Object.freeze({
    async saveCandidate(
      input: SaveFounderProfileCandidateInput
    ): Promise<FounderCandidateResult> {
      if (typeof input !== "object" || input === null) {
        throw validationError("input", "must_be_object");
      }
      const requestNow = trustedNow(now());

      const founderName = validateBoundedString(
        "founderName",
        input.founderName,
        CANDIDATE_FIELD_LIMITS.founderName
      )!;
      const searchQuery = validateBoundedString(
        "searchQuery",
        input.searchQuery,
        CANDIDATE_FIELD_LIMITS.searchQuery
      )!;
      const resultTitle = validateBoundedString(
        "resultTitle",
        input.resultTitle,
        CANDIDATE_FIELD_LIMITS.resultTitle,
        { optional: true }
      );
      const resultSnippet = validateBoundedString(
        "resultSnippet",
        input.resultSnippet,
        CANDIDATE_FIELD_LIMITS.resultSnippet,
        { optional: true }
      );
      if (resultTitle === undefined && resultSnippet === undefined) {
        throw validationError("resultEvidence", "title_or_snippet_required");
      }
      validateNotFetched(input.linkedInNotFetched);
      const checkedAt = validateCheckedAt(input.checkedAt, requestNow);
      const confidence = validateConfidence(input.confidence);
      const { normalizedProfileUrl, exactResultUrl } = validateCandidateUrls(
        input.candidateProfileUrl,
        input.resultUrl
      );

      const { company, person, runPerson } = await loadOwnedContext(input);
      const submittedName = normalizedNameSignature(founderName);
      const persistedName = normalizedNameSignature(person.name);
      if (
        submittedName === undefined
        || persistedName === undefined
        || submittedName !== persistedName
      ) {
        throw evidenceMismatch("founderName", "persisted_identity_mismatch");
      }
      if (typeof input.founderRole !== "string") {
        throw validationError(
          "founderRole",
          "invalid_role_type",
          CANDIDATE_FIELD_LIMITS.founderRole
        );
      }
      const roleContext = currentFounderRoleContext(person, requestNow);
      const submittedRole = validateFounderRole(input.founderRole, roleContext);
      if (!submittedRole.ok) {
        if (
          submittedRole.reason === "INVALID_ROLE_TYPE"
          || submittedRole.reason === "EMPTY_ROLE"
          || submittedRole.reason === "UNSAFE_ROLE_CHARACTERS"
          || submittedRole.reason === "ROLE_TOO_LONG"
          || submittedRole.reason === "ROLE_TOO_LARGE"
        ) {
          throw validationError(
            "founderRole",
            submittedRole.reason.toLocaleLowerCase("en-US"),
            CANDIDATE_FIELD_LIMITS.founderRole
          );
        }
        throw evidenceMismatch("founderRole", "founder_role_not_supported");
      }
      const persistedRole = validateFounderRole(person.role, roleContext);
      if (!persistedRole.ok) {
        throw evidenceMismatch("founderRole", "persisted_role_not_supported");
      }
      if (
        submittedRole.normalizedRole.toLocaleLowerCase("en-US")
        !== persistedRole.normalizedRole.toLocaleLowerCase("en-US")
      ) {
        throw evidenceMismatch("founderRole", "persisted_role_mismatch");
      }
      const founderEvidenceTokens = comparableTokens(person.name);
      const companyEvidenceTokens = companyIdentityTokens(company.name);
      const fieldMatches = [
        matchResultField(
          resultTitle,
          founderEvidenceTokens,
          companyEvidenceTokens
        ),
        matchResultField(
          resultSnippet,
          founderEvidenceTokens,
          companyEvidenceTokens
        )
      ];
      if (!fieldMatches.some(({ founder }) => founder)) {
        throw evidenceMismatch("resultEvidence", "founder_identity_mismatch");
      }
      if (!fieldMatches.some(({ company: matched }) => matched)) {
        throw evidenceMismatch("resultEvidence", "company_context_mismatch");
      }
      if (!fieldMatches.some(({ bound }) => bound)) {
        throw evidenceMismatch("resultEvidence", "entity_binding_mismatch");
      }

      const candidate = await withPersistenceMapping(
        "write",
        async () => await database.founderProfileCandidates.saveCandidate({
          runPersonId: runPerson.id,
          ownerSubject: subject,
          profileUrl: normalizedProfileUrl,
          searchQuery,
          evidenceUrl: exactResultUrl,
          ...(resultTitle === undefined ? {} : { evidenceTitle: resultTitle }),
          ...(resultSnippet === undefined ? {} : { evidenceSnippet: resultSnippet }),
          evidenceMetadataJson: {
            linkedInNotFetched: true,
            submittedFounderName: founderName,
            submittedFounderRole: input.founderRole,
            founderRoleBasis: submittedRole.basis,
            companyId: person.companyId,
            personId: person.id,
            runId: input.runId,
            runItemId: runPerson.runItemId
          },
          checkedAt,
          confidence
        })
      );
      const state = await loadCandidateState(runPerson.id);
      return Object.freeze({
        candidate,
        ...state
      });
    },

    async decideCandidate(
      input: FounderProfileCandidateDecisionInput
    ): Promise<FounderCandidateResult> {
      if (typeof input !== "object" || input === null) {
        throw validationError("input", "must_be_object");
      }
      const validated = validateDecision(input);
      const decidedAt = trustedNow(now()).toISOString();
      const candidate = await withPersistenceMapping("write", async () => {
        const decided = validated.decision === "CONFIRM"
          ? await database.founderProfileCandidates.confirm({
              candidateId: validated.candidateId,
              ownerSubject: subject,
              ...(validated.note === undefined ? {} : { note: validated.note }),
              decidedAt
            })
          : await database.founderProfileCandidates.reject({
              candidateId: validated.candidateId,
              ownerSubject: subject,
              ...(validated.note === undefined ? {} : { note: validated.note }),
              decidedAt
            });
        if (decided === undefined) {
          throw notFound();
        }
        return decided;
      });
      const state = await loadCandidateState(candidate.runPersonId);
      return Object.freeze({
        candidate,
        ...state
      });
    }
  });
}
