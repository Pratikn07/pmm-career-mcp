import { createHash } from "node:crypto";
import type { CareerDatabase } from "../db/client.js";
import type { FounderResearchExportSnapshot } from "../db/repositories.js";
import { DomainError } from "../domain/errors.js";
import {
  issuePrivateFounderExportCapability,
  type PrivateFounderExportCapability
} from "./download-capability.js";
import {
  buildFounderResearchWorkbook,
  type FounderResearchWorkbookInput,
  type FounderResearchWorkbookRow
} from "./workbook.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EXPORT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const OUTREACH_PURPOSE = "linkedin_connection_request";

export type CreateFounderResearchExportInput = Readonly<{
  runId: string;
  idempotencyKey: string;
}>;

export type FounderResearchExportMetadata = Readonly<{
  id: string;
  fileName: string;
  mimeType: typeof XLSX_MIME;
  byteSize: number;
  checksumSha256: string;
  rowCount: number;
  sheetCount: 4;
  expiresAt: string;
}>;

export type PrivateFounderExportMetadataConsumer = (
  metadata: PrivateFounderExportCapability
) => void;

function validationError(field: string, reason: string): DomainError {
  return new DomainError("VALIDATION_ERROR", "Founder export input is invalid", { field, reason });
}

function notFound(): DomainError {
  return new DomainError("NOT_FOUND", "Founder research run was not found");
}

function trustedNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("DATA_INTEGRITY", "Founder export clock is invalid");
  }
  return value;
}

function safeFilters(value: Record<string, unknown>): Record<string, boolean | number | string> {
  const output: Record<string, boolean | number | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "boolean" || (
      typeof item === "number" && Number.isFinite(item)
    )) {
      output[key] = item;
      continue;
    }
    throw new DomainError("DATA_INTEGRITY", "Founder research run is invalid");
  }
  return output;
}

function scopedIdempotencyKeyHash(
  ownerSubject: string,
  runId: string,
  idempotencyKey: string
): string {
  return createHash("sha256").update(JSON.stringify({
    contract: "founder-research-export.idempotency.v1",
    ownerSubject,
    runId,
    idempotencyKey
  }), "utf8").digest("hex");
}

function selectedCandidate(
  candidates: FounderResearchExportSnapshot["items"][number]["people"][number]["candidates"]
) {
  const precedence: Record<string, number> = {
    CONFIRMED: 0,
    VERIFIED: 1,
    CANDIDATE: 2,
    REJECTED: 3
  };
  return [...candidates].sort((left, right) => (
    (precedence[left.status] ?? 4) - (precedence[right.status] ?? 4)
    || right.checkedAt.localeCompare(left.checkedAt)
    || left.id.localeCompare(right.id)
  ))[0];
}

function safeFailure(item: FounderResearchExportSnapshot["items"][number]["item"]) {
  switch (item.errorCode) {
    case "DISCOVERY_BUDGET_EXHAUSTED":
      return {
        errorCode: "DISCOVERY_BUDGET_EXHAUSTED",
        errorSummary: "Official founder discovery exceeded its bounded time budget"
      } as const;
    case "FOUNDER_NOT_FOUND":
      return {
        errorCode: "FOUNDER_NOT_FOUND",
        errorSummary: "No supported founder evidence was found."
      } as const;
    case "STALE_WORKER":
      return {
        errorCode: "STALE_WORKER",
        errorSummary: "A stale worker result was not applied."
      } as const;
    default:
      return {
        errorCode: "OFFICIAL_SOURCE_UNAVAILABLE",
        errorSummary: "Official founder sources could not be processed safely"
      } as const;
  }
}

function snapshotRows(snapshot: FounderResearchExportSnapshot): FounderResearchWorkbookRow[] {
  const rows: FounderResearchWorkbookRow[] = [];
  for (const { item, company, people } of snapshot.items) {
    const shared = {
      companyName: company.name,
      ...(company.batch === null ? {} : { ycBatch: company.batch }),
      ...(company.status === null ? {} : { companyStatus: company.status }),
      ...(company.isHiring === null ? {} : { hiring: company.isHiring }),
      ...(company.websiteUrl === null ? {} : { companyWebsiteUrl: company.websiteUrl })
    };
    if (people.length === 0) {
      if (item.state === "NOT_FOUND" || item.state === "FAILED") {
        rows.push({
          id: item.id,
          state: item.state,
          ...shared,
          checkedAt: item.checkedAt ?? item.updatedAt,
          confidence: 0,
          ...safeFailure(item)
        });
      } else {
        rows.push({
          id: item.id,
          state: "AMBIGUOUS",
          ...shared,
          checkedAt: item.checkedAt ?? item.updatedAt,
          confidence: 0,
          requiredManualAction: "Complete founder research before exporting this company."
        });
      }
      continue;
    }
    for (const { runPerson, person, candidates, target, drafts } of people) {
      const candidate = selectedCandidate(candidates);
      const sharedPerson = {
        id: runPerson.id,
        ...shared,
        founderName: person.name,
        founderRole: runPerson.founderRoleMatch,
        checkedAt: candidate?.checkedAt ?? person.checkedAt ?? item.checkedAt ?? item.updatedAt,
        confidence: candidate?.confidence ?? runPerson.confidence,
        personId: person.id
      };
      const draft = target === undefined ? undefined : drafts.find((entry) => (
        entry.purpose === OUTREACH_PURPOSE
      ));
      if (
        candidate !== undefined
        && (candidate.status === "CONFIRMED" || candidate.status === "VERIFIED")
        && target !== undefined
        && draft !== undefined
      ) {
        rows.push({
          ...sharedPerson,
          state: candidate.status,
          canonicalProfileUrl: candidate.profileUrl,
          profileEvidence: candidate.evidenceTitle ?? candidate.evidenceSnippet ?? candidate.evidenceUrl,
          personalizationRationale: target.rationale,
          draftConnectionNote: draft.text,
          noteReviewStatus: "READY_TO_REVIEW",
          outreachStatus: target.status,
          targetId: target.id,
          draftId: draft.id
        });
      } else if (candidate !== undefined && candidate.status === "CANDIDATE") {
        rows.push({
          ...sharedPerson,
          state: "CANDIDATE",
          candidateProfileUrl: candidate.profileUrl,
          ...(candidate.searchQuery === null ? {} : { searchQuery: candidate.searchQuery }),
          evidenceUrl: candidate.evidenceUrl,
          ...(candidate.evidenceSnippet !== null ? { evidenceSnippet: candidate.evidenceSnippet }
            : candidate.evidenceTitle !== null ? { evidenceSnippet: candidate.evidenceTitle } : {}),
          requiredManualAction: "Confirm or reject this candidate URL."
        });
      } else {
        rows.push({
          ...sharedPerson,
          state: "AMBIGUOUS",
          ...(candidate === undefined ? {} : {
            ...(candidate.searchQuery === null ? {} : { searchQuery: candidate.searchQuery }),
            evidenceUrl: candidate.evidenceUrl,
            ...(candidate.evidenceSnippet !== null ? { evidenceSnippet: candidate.evidenceSnippet }
              : candidate.evidenceTitle !== null ? { evidenceSnippet: candidate.evidenceTitle } : {})
          }),
          requiredManualAction: candidate !== undefined
            ? "Save an evidence-backed outreach draft after manual review."
            : "Find and confirm a public LinkedIn profile before outreach."
        });
      }
    }
  }
  return rows;
}

function workbookInput(snapshot: FounderResearchExportSnapshot): FounderResearchWorkbookInput {
  return {
    run: {
      id: snapshot.run.id,
      state: snapshot.run.state as FounderResearchWorkbookInput["run"]["state"],
      filters: safeFilters(snapshot.run.queryJson),
      requestedLimit: snapshot.run.requestedLimit,
      createdAt: snapshot.run.createdAt,
      ...(snapshot.run.startedAt === null ? {} : { startedAt: snapshot.run.startedAt }),
      ...(snapshot.run.completedAt === null ? {} : { completedAt: snapshot.run.completedAt })
    },
    rows: snapshotRows(snapshot),
    includeCandidateUrls: true
  };
}

function metadata(exportRow: {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  rowCount: number;
  sheetCount: number;
  expiresAt: string;
}): FounderResearchExportMetadata {
  return Object.freeze({
    id: exportRow.id,
    fileName: exportRow.fileName,
    mimeType: XLSX_MIME,
    byteSize: exportRow.byteSize,
    checksumSha256: exportRow.checksumSha256,
    rowCount: exportRow.rowCount,
    sheetCount: 4,
    expiresAt: exportRow.expiresAt
  });
}

export function createFounderResearchExportService(
  database: CareerDatabase,
  dependencies: Readonly<{ subject: string; now?: () => Date }>
) {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError("AUTH_REQUIRED", "Authenticated request identity is required");
  }
  const subject = dependencies.subject.toLowerCase();
  const now = dependencies.now ?? (() => new Date());
  return Object.freeze({
    async createExport(
      input: CreateFounderResearchExportInput,
      privateMetadataConsumer: PrivateFounderExportMetadataConsumer
    ): Promise<FounderResearchExportMetadata> {
      if (!UUID_PATTERN.test(input.runId)) throw validationError("runId", "must_be_uuid");
      if (
        typeof input.idempotencyKey !== "string"
        || input.idempotencyKey.length === 0
        || input.idempotencyKey.length > 200
        || /[\p{Cc}\p{Cf}]/u.test(input.idempotencyKey)
      ) {
        throw validationError("idempotencyKey", "must_be_safe_bounded_text");
      }
      const createdAt = trustedNow(now);
      const snapshot = await database.founderResearchRuns.getExportSnapshot(
        input.runId.toLowerCase(),
        subject
      );
      if (snapshot === undefined) throw notFound();
      const bytes = await buildFounderResearchWorkbook(workbookInput(snapshot));
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      const exportRow = await database.founderResearchExports.createOrReuse({
        runId: snapshot.run.id,
        ownerSubject: subject,
        idempotencyKeyHash: scopedIdempotencyKeyHash(subject, snapshot.run.id, input.idempotencyKey),
        fileName: `founder-research-${snapshot.run.id}.xlsx`,
        mimeType: XLSX_MIME,
        checksumSha256,
        workbookBytes: bytes,
        rowCount: workbookInput(snapshot).rows.length,
        sheetCount: 4,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + EXPORT_LIFETIME_MS).toISOString()
      });
      const privateMetadata = await issuePrivateFounderExportCapability(database, {
        exportId: exportRow.id,
        ownerSubject: subject,
        now: createdAt
      });
      privateMetadataConsumer(privateMetadata);
      return metadata(exportRow);
    },
    async cleanupExpired(): Promise<number> {
      return await database.founderResearchExports.deleteExpired(
        subject,
        trustedNow(now).toISOString()
      );
    }
  });
}
