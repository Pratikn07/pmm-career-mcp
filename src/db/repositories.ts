import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  companies,
  evidence,
  oauthTokens,
  outreachDrafts,
  people,
  postDraftMedia,
  postDrafts,
  postMedia,
  postPreviews,
  publishAttemptMedia,
  publishAttempts,
  schema,
  settings,
  shortlistEntries,
  shortlists,
  targetNotes,
  targets
} from "./schema.js";
import { checksumLinkedInPost } from "../posts/post-checksum.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Setting = typeof settings.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type TargetNote = typeof targetNotes.$inferSelect;
export type OutreachDraftRow = typeof outreachDrafts.$inferSelect;
export type OutreachDraft = Omit<OutreachDraftRow, "evidenceIdsJson"> & { evidenceIds: string[] };
export type Shortlist = typeof shortlists.$inferSelect;
export type ShortlistEntry = typeof shortlistEntries.$inferSelect;
export type ShortlistWithEntries = Shortlist & { entries: ShortlistEntry[] };
export type PostMedia = typeof postMedia.$inferSelect;
export type PostDraft = typeof postDrafts.$inferSelect;
export type PostDraftMedia = typeof postDraftMedia.$inferSelect;
export type PostDraftMediaWithMetadata = PostDraftMedia & Omit<PostMedia, "id">;
export type PostPreview = typeof postPreviews.$inferSelect;
export type PublishAttempt = typeof publishAttempts.$inferSelect;
export type PublishAttemptMedia = typeof publishAttemptMedia.$inferSelect;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type PersonWithEvidence = Person & { evidence: Evidence[] };

export type CompanyUpsertInput = {
  ycId: string;
  name: string;
  batch?: string;
  status?: string;
  websiteUrl?: string;
  ycUrl?: string;
  location?: string;
  industry?: string;
  isHiring?: boolean;
  checkedAt?: string;
};

export type PersonUpsertInput = {
  companyId: string;
  name: string;
  role: string;
  publicProfileUrl?: string;
  checkedAt?: string;
};

export type EvidenceAddInput = {
  personId: string;
  sourceUrl: string;
  title?: string;
  factType?: string;
  fact: string;
  checkedAt: string;
  confidence: number;
};

export type CompanyPersonDiscoveryRefreshInput = {
  companyId: string;
  replaceMissingDiscovery?: boolean;
  people: Array<{
    name: string;
    role: string;
    publicProfileUrl?: string;
    checkedAt: string;
    evidence: Array<Omit<EvidenceAddInput, "personId">>;
  }>;
};

export type TargetUpsertInput = {
  personId: string;
  pmmOpportunity: number;
  referralPotential: number;
  networkValue: number;
  totalScore: number;
  confidence: number;
  rationale: string;
};

export type TargetListFilter = {
  companyId?: string;
  status?: string;
};

export type OutreachDraftVersionInput = {
  targetId: string;
  purpose: string;
  text: string;
  evidenceIds: string[];
};

export type PostDraftVersionInput = {
  draftId?: string;
  text: string;
  visibility: string;
  checksum: string | ((version: number) => string);
  state: string;
};

export type PostMediaCreateInput = Omit<typeof postMedia.$inferInsert, "createdAt"> & {
  createdAt?: string;
};

export type PostDraftVersionWithMediaInput = Omit<PostDraftVersionInput, "checksum"> & {
  ownerSubject?: string;
  expectedVersion?: number;
  media: readonly { mediaId: string; altText: string }[];
  checksum: string | ((
    version: number,
    draftId: string,
    media: readonly {
      position: number;
      sha256: string;
      mimeType: string;
      altText: string;
    }[]
  ) => string);
};

export class PostDraftVersionConflictError extends Error {
  constructor() {
    super("Post draft version is stale");
    this.name = "PostDraftVersionConflictError";
  }
}

export type PublishAttemptMediaUpdateInput = {
  id: string;
  expectedState?: string;
  state: string;
  linkedinImageUrn?: string | null;
};

export type PreviewExpectedRow = {
  postId: string;
  versionId: string;
  version: number;
  checksum: string;
  visibility: string;
};

export type PreviewCreationResult =
  | { outcome: "created"; post: PostDraft; preview: PostPreview }
  | {
      outcome:
        | "not_found"
        | "not_latest"
        | "invalid_state"
        | "integrity_mismatch";
    };

export type ExactPreviewSnapshotExpected = Readonly<{
  subject: string;
  post: Readonly<Pick<
    PostDraft,
    "id" | "draftId" | "text" | "visibility" | "version" | "checksum"
  >>;
  media: readonly Readonly<PostDraftMediaWithMetadata>[];
}>;

export type PreviewConsumptionResult =
  | { outcome: "consumed"; post: PostDraft; preview: PostPreview }
  | {
      outcome:
        | "not_found"
        | "already_consumed"
        | "expired"
        | "mismatch"
        | "stale"
        | "invalid_state"
        | "race";
    };

export type PreviewConsumptionInput = {
  tokenHash: string;
  consumedAt: string;
  expected: PreviewExpectedRow;
  allowedStates: readonly string[];
  claimState?: string;
};

export type PublishAttemptRecordInput = Omit<typeof publishAttempts.$inferInsert, "id">;

export type PublishClaimRecordResult =
  | {
      outcome: "recorded";
      post: PostDraft;
      preview: PostPreview;
      attempt: PublishAttempt;
    }
  | Exclude<PreviewConsumptionResult, { outcome: "consumed" }>;

const SERIALIZABLE_RETRY_DELAYS_MS = Object.freeze([5, 15]);

function postgresErrorField(error: unknown, field: "code" | "constraint_name"): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (field in current && typeof (current as Record<string, unknown>)[field] === "string") {
      return (current as Record<string, string>)[field];
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function isRetryableTransactionError(error: unknown, uniqueConstraint?: string): boolean {
  const code = postgresErrorField(error, "code");
  if (code === "40001" || code === "40P01") {
    return true;
  }
  return code === "23505"
    && uniqueConstraint !== undefined
    && postgresErrorField(error, "constraint_name") === uniqueConstraint;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function serializableTransaction<T>(
  database: Database,
  operation: (transaction: Database) => Promise<T>,
  uniqueConstraint?: string
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await database.transaction(operation, {
        isolationLevel: "serializable",
        accessMode: "read write"
      });
    } catch (error) {
      const retryDelay = SERIALIZABLE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isRetryableTransactionError(error, uniqueConstraint)) {
        throw error;
      }
      await delay(retryDelay);
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertIsoTimestamp(field: string, value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp in YYYY-MM-DDTHH:mm:ss.sssZ format`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function normalizeRowTimestamps<T extends Record<string, unknown>>(row: T): T {
  const normalized: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(normalized)) {
    if (key.endsWith("At") && value !== null && value !== undefined) {
      const parsed = value instanceof Date ? value : new Date(String(value));
      normalized[key] = parsed.toISOString();
    }
  }
  return normalized as T;
}

function normalizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(normalizeRowTimestamps);
}

function requiredRow<T extends Record<string, unknown>>(row: T | undefined, entity: string): T {
  if (row === undefined) {
    throw new Error(`${entity} write did not return a row`);
  }
  return normalizeRowTimestamps(row);
}

function decodeOutreachDraft(row: OutreachDraftRow): OutreachDraft {
  const { evidenceIdsJson, ...draft } = normalizeRowTimestamps(row);
  return { ...draft, evidenceIds: [...evidenceIdsJson] };
}

function normalizedPersonIdentity(name: string, role: string): string {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
  return `${normalize(name)}\u0000${normalize(role)}`;
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isExactPreviewMimeType(
  value: string
): value is "image/jpeg" | "image/png" | "image/gif" {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif";
}

function exactPreviewSnapshotMatches(
  post: PostDraft,
  media: readonly PostDraftMediaWithMetadata[],
  expected: ExactPreviewSnapshotExpected
): boolean {
  if (
    !isUuid(expected.subject)
    || post.id !== expected.post.id
    || post.draftId !== expected.post.draftId
    || post.text !== expected.post.text
    || post.visibility !== expected.post.visibility
    || post.version !== expected.post.version
    || post.checksum !== expected.post.checksum
    || media.length !== expected.media.length
    || media.length > 4
    || (post.visibility !== "PUBLIC" && post.visibility !== "CONNECTIONS")
  ) {
    return false;
  }

  const subject = expected.subject.toLowerCase();
  for (let position = 0; position < media.length; position += 1) {
    const current = media[position]!;
    const signed = expected.media[position]!;
    if (
      current.postDraftId !== post.id
      || current.version !== post.version
      || current.position !== position
      || current.ownerSubject.toLowerCase() !== subject
      || !current.objectPath.startsWith(`${subject}/`)
      || current.postDraftId !== signed.postDraftId
      || current.version !== signed.version
      || current.position !== signed.position
      || current.mediaId !== signed.mediaId
      || current.altText !== signed.altText
      || current.ownerSubject !== signed.ownerSubject
      || current.objectPath !== signed.objectPath
      || current.sha256 !== signed.sha256
      || current.mimeType !== signed.mimeType
      || current.byteSize !== signed.byteSize
      || current.width !== signed.width
      || current.height !== signed.height
      || current.frameCount !== signed.frameCount
      || current.originalFilename !== signed.originalFilename
      || current.createdAt !== signed.createdAt
      || !isExactPreviewMimeType(current.mimeType)
    ) {
      return false;
    }
  }

  try {
    const recomputed = checksumLinkedInPost({
      draftId: post.draftId,
      version: post.version,
      text: post.text,
      visibility: post.visibility,
      media: media.map(({ position, sha256, mimeType, altText }) => {
        if (!isExactPreviewMimeType(mimeType)) {
          throw new TypeError("Stored exact-preview media type is invalid");
        }
        return { position, sha256, mimeType, altText };
      })
    });
    return timingSafeTextEqual(recomputed, post.checksum)
      && timingSafeTextEqual(recomputed, expected.post.checksum);
  } catch {
    return false;
  }
}

export function createRepositories(database: Database) {
  function postDraftMediaForVersionQuery(
    queryDatabase: Database,
    postDraftId: string,
    version: number
  ) {
    return queryDatabase.select({
      postDraftId: postDraftMedia.postDraftId,
      version: postDraftMedia.version,
      position: postDraftMedia.position,
      mediaId: postDraftMedia.mediaId,
      altText: postDraftMedia.altText,
      ownerSubject: postMedia.ownerSubject,
      objectPath: postMedia.objectPath,
      sha256: postMedia.sha256,
      mimeType: postMedia.mimeType,
      byteSize: postMedia.byteSize,
      width: postMedia.width,
      height: postMedia.height,
      frameCount: postMedia.frameCount,
      originalFilename: postMedia.originalFilename,
      createdAt: postMedia.createdAt
    }).from(postDraftMedia).innerJoin(
      postMedia,
      eq(postDraftMedia.mediaId, postMedia.id)
    ).where(and(
      eq(postDraftMedia.postDraftId, postDraftId),
      eq(postDraftMedia.version, version)
    )).orderBy(asc(postDraftMedia.position));
  }

  async function listPostDraftMediaForVersion(
    queryDatabase: Database,
    postDraftId: string,
    version: number
  ): Promise<PostDraftMediaWithMetadata[]> {
    const rows = await postDraftMediaForVersionQuery(queryDatabase, postDraftId, version);
    return normalizeRows(rows);
  }

  async function lockPostDraftMediaForVersion(
    queryDatabase: Database,
    postDraftId: string,
    version: number
  ): Promise<PostDraftMediaWithMetadata[]> {
    const lockedDraftMedia = await queryDatabase.select({
      postDraftId: postDraftMedia.postDraftId,
      version: postDraftMedia.version,
      position: postDraftMedia.position,
      mediaId: postDraftMedia.mediaId,
      altText: postDraftMedia.altText
    }).from(postDraftMedia).where(and(
      eq(postDraftMedia.postDraftId, postDraftId),
      eq(postDraftMedia.version, version)
    )).orderBy(asc(postDraftMedia.position)).for("update");
    if (lockedDraftMedia.length === 0) {
      return [];
    }

    const sortedMediaIds = lockedDraftMedia
      .map(({ mediaId }) => mediaId.toLowerCase())
      .sort();
    if (new Set(sortedMediaIds).size !== sortedMediaIds.length) {
      return [];
    }
    const lockedMedia = await queryDatabase.select({
      id: postMedia.id,
      ownerSubject: postMedia.ownerSubject,
      objectPath: postMedia.objectPath,
      sha256: postMedia.sha256,
      mimeType: postMedia.mimeType,
      byteSize: postMedia.byteSize,
      width: postMedia.width,
      height: postMedia.height,
      frameCount: postMedia.frameCount,
      originalFilename: postMedia.originalFilename,
      createdAt: postMedia.createdAt
    }).from(postMedia).where(
      inArray(postMedia.id, sortedMediaIds)
    ).orderBy(asc(postMedia.id)).for("update");
    if (lockedMedia.length !== sortedMediaIds.length) {
      return [];
    }

    const mediaById = new Map(lockedMedia.map((media) => [
      media.id.toLowerCase(),
      normalizeRowTimestamps(media)
    ]));
    return lockedDraftMedia.flatMap((draftMedia) => {
      const media = mediaById.get(draftMedia.mediaId.toLowerCase());
      if (media === undefined) {
        return [];
      }
      const { id: _id, ...metadata } = media;
      return [{ ...draftMedia, ...metadata }];
    });
  }

  async function consumePreviewExact(
    transaction: Database,
    input: PreviewConsumptionInput
  ): Promise<PreviewConsumptionResult> {
    const [previewRow] = await transaction.select().from(postPreviews).where(
      eq(postPreviews.tokenHash, input.tokenHash)
    ).for("update");
    if (
      previewRow === undefined
      || !timingSafeTextEqual(previewRow.tokenHash, input.tokenHash)
    ) {
      return { outcome: "not_found" };
    }
    const preview = normalizeRowTimestamps(previewRow);
    if (preview.consumedAt !== null) {
      return { outcome: "already_consumed" };
    }
    if (input.consumedAt >= preview.expiresAt) {
      return { outcome: "expired" };
    }
    const [postRow] = await transaction.select().from(postDrafts).where(and(
      eq(postDrafts.id, preview.postDraftId),
      eq(postDrafts.version, preview.version)
    )).for("update");
    if (postRow === undefined) {
      return { outcome: "stale" };
    }
    const post = normalizeRowTimestamps(postRow);
    if (
      input.expected.postId !== post.draftId
      || input.expected.versionId !== post.id
      || input.expected.version !== post.version
      || input.expected.checksum !== post.checksum
      || input.expected.visibility !== post.visibility
    ) {
      return { outcome: "mismatch" };
    }
    const [latest] = await transaction.select().from(postDrafts).where(
      eq(postDrafts.draftId, post.draftId)
    ).orderBy(desc(postDrafts.version)).limit(1).for("update");
    if (latest === undefined || latest.id !== post.id) {
      return { outcome: "stale" };
    }
    if (!input.allowedStates.includes(post.state)) {
      return { outcome: "invalid_state" };
    }
    const [consumedRow] = await transaction.update(postPreviews).set({
      consumedAt: input.consumedAt
    }).where(and(
      eq(postPreviews.id, preview.id),
      isNull(postPreviews.consumedAt)
    )).returning();
    if (consumedRow === undefined) {
      return { outcome: "race" };
    }
    const consumed = normalizeRowTimestamps(consumedRow);
    if (input.claimState !== undefined) {
      const [claimed] = await transaction.update(postDrafts).set({
        state: input.claimState,
        updatedAt: nowIso()
      }).where(and(
        eq(postDrafts.id, post.id),
        eq(postDrafts.version, post.version),
        eq(postDrafts.state, post.state)
      )).returning();
      if (claimed === undefined) {
        throw new Error("Publish claim state changed before preview consumption completed");
      }
    }
    return { outcome: "consumed", post, preview: consumed };
  }

  function recordPublishAttempt(input: PublishAttemptRecordInput): Promise<PublishAttempt>;
  function recordPublishAttempt(
    input: PublishAttemptRecordInput,
    claim: PreviewConsumptionInput & { claimState: string }
  ): Promise<PublishClaimRecordResult>;
  async function recordPublishAttempt(
    input: PublishAttemptRecordInput,
    claim?: PreviewConsumptionInput & { claimState: string }
  ): Promise<PublishAttempt | PublishClaimRecordResult> {
    assertIsoTimestamp("publishAttempt.requestedAt", input.requestedAt);
    if (input.completedAt !== undefined && input.completedAt !== null) {
      assertIsoTimestamp("publishAttempt.completedAt", input.completedAt);
    }
    if (claim !== undefined) {
      assertIsoTimestamp("preview.consumedAt", claim.consumedAt);
    }
    return serializableTransaction(database, async (transaction) => {
      let claimed: Extract<PreviewConsumptionResult, { outcome: "consumed" }> | undefined;
      if (claim !== undefined) {
        const result = await consumePreviewExact(transaction, claim);
        if (result.outcome !== "consumed") {
          return result;
        }
        claimed = result;
        if (
          input.postDraftId !== claimed.post.id
          || input.version !== claimed.post.version
        ) {
          throw new Error("Publish attempt does not match preview claim");
        }
      }
      const [attempt] = await transaction.insert(publishAttempts).values({
        id: randomUUID(),
        ...input
      }).returning();
      const recordedAttempt = requiredRow(attempt, "publish attempt");
      return claimed === undefined
        ? recordedAttempt
        : {
            outcome: "recorded" as const,
            post: claimed.post,
            preview: claimed.preview,
            attempt: recordedAttempt
          };
    });
  }

  return {
    settings: {
      async set(key: string, value: unknown): Promise<Setting> {
        const updatedAt = nowIso();
        const [setting] = await database.insert(settings).values({
          id: randomUUID(),
          key,
          valueJson: value,
          updatedAt
        }).onConflictDoUpdate({
          target: settings.key,
          set: { valueJson: value, updatedAt }
        }).returning();
        return requiredRow(setting, "setting");
      },
      async get<T = unknown>(key: string): Promise<T | undefined> {
        const [setting] = await database.select().from(settings).where(eq(settings.key, key));
        return setting === undefined ? undefined : setting.valueJson as T;
      }
    },
    companies: {
      async upsert(input: CompanyUpsertInput): Promise<Company> {
        const now = nowIso();
        const checkedAt = input.checkedAt === undefined
          ? undefined
          : assertIsoTimestamp("company.checkedAt", input.checkedAt);
        await database.insert(companies).values({
          id: randomUUID(),
          ycId: input.ycId,
          name: input.name,
          ...(input.batch === undefined ? {} : { batch: input.batch }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
          ...(input.ycUrl === undefined ? {} : { ycUrl: input.ycUrl }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.industry === undefined ? {} : { industry: input.industry }),
          ...(input.isHiring === undefined ? {} : { isHiring: input.isHiring }),
          ...(checkedAt === undefined ? {} : { checkedAt }),
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: companies.ycId,
          set: {
            name: input.name,
            ...(input.batch === undefined ? {} : { batch: input.batch }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
            ...(input.ycUrl === undefined ? {} : { ycUrl: input.ycUrl }),
            ...(input.location === undefined ? {} : { location: input.location }),
            ...(input.industry === undefined ? {} : { industry: input.industry }),
            ...(input.isHiring === undefined ? {} : { isHiring: input.isHiring }),
            ...(checkedAt === undefined ? {} : { checkedAt }),
            updatedAt: now
          }
        });
        const [company] = await database.select().from(companies).where(eq(
          companies.ycId,
          input.ycId
        ));
        return requiredRow(company, "company");
      },
      async get(id: string): Promise<Company | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [company] = await database.select().from(companies).where(eq(companies.id, id));
        return company === undefined ? undefined : normalizeRowTimestamps(company);
      },
      async getByYcId(ycId: string): Promise<Company | undefined> {
        const [company] = await database.select().from(companies).where(eq(companies.ycId, ycId));
        return company === undefined ? undefined : normalizeRowTimestamps(company);
      },
      async list(): Promise<Company[]> {
        const rows = await database.select().from(companies).orderBy(
          asc(companies.name),
          asc(companies.id)
        );
        return normalizeRows(rows);
      }
    },
    people: {
      async upsert(input: PersonUpsertInput): Promise<Person> {
        const now = nowIso();
        const checkedAt = input.checkedAt === undefined
          ? undefined
          : assertIsoTimestamp("person.checkedAt", input.checkedAt);
        await database.insert(people).values({
          id: randomUUID(),
          companyId: input.companyId,
          name: input.name,
          role: input.role,
          ...(input.publicProfileUrl === undefined ? {} : { publicProfileUrl: input.publicProfileUrl }),
          ...(checkedAt === undefined ? {} : { checkedAt }),
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: [people.companyId, people.name, people.role],
          set: {
            ...(input.publicProfileUrl === undefined ? {} : { publicProfileUrl: input.publicProfileUrl }),
            ...(checkedAt === undefined ? {} : { checkedAt }),
            updatedAt: now
          }
        });
        const [person] = await database.select().from(people).where(and(
          eq(people.companyId, input.companyId),
          eq(people.name, input.name),
          eq(people.role, input.role)
        ));
        return requiredRow(person, "person");
      },
      async get(id: string): Promise<Person | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [person] = await database.select().from(people).where(eq(people.id, id));
        return person === undefined ? undefined : normalizeRowTimestamps(person);
      },
      async listByCompany(companyId: string): Promise<Person[]> {
        if (!isUuid(companyId)) {
          return [];
        }
        const rows = await database.select().from(people).where(eq(people.companyId, companyId)).orderBy(
          asc(people.name),
          asc(people.role)
        );
        return normalizeRows(rows);
      },
      async getWithEvidence(id: string): Promise<PersonWithEvidence | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [person] = await database.select().from(people).where(eq(people.id, id));
        if (person === undefined) {
          return undefined;
        }
        const evidenceRows = await database.select().from(evidence).where(
          eq(evidence.personId, id)
        ).orderBy(asc(evidence.checkedAt), asc(evidence.id));
        return {
          ...normalizeRowTimestamps(person),
          evidence: normalizeRows(evidenceRows)
        };
      },
      async refreshDiscovery(
        input: CompanyPersonDiscoveryRefreshInput
      ): Promise<PersonWithEvidence[]> {
        return serializableTransaction(database, async (transaction) => {
          await transaction.select({ id: companies.id }).from(companies).where(
            eq(companies.id, input.companyId)
          ).for("update");
          const existingPeople = normalizeRows(await transaction.select().from(people).where(
            eq(people.companyId, input.companyId)
          ).orderBy(asc(people.name), asc(people.role), asc(people.id)));
          const existingByIdentity = new Map<string, Person>();
          for (const person of existingPeople) {
            const key = normalizedPersonIdentity(person.name, person.role);
            if (!existingByIdentity.has(key)) {
              existingByIdentity.set(key, person);
            }
          }
          const refreshed: PersonWithEvidence[] = [];
          const refreshedPersonIds = new Set<string>();
          for (const personInput of input.people) {
            const name = personInput.name.replace(/\s+/g, " ").trim();
            const role = personInput.role.replace(/\s+/g, " ").trim();
            const checkedAt = assertIsoTimestamp("person.checkedAt", personInput.checkedAt);
            const identity = normalizedPersonIdentity(name, role);
            const existing = existingByIdentity.get(identity);
            const now = nowIso();
            const [personRow] = existing === undefined
              ? await transaction.insert(people).values({
                  id: randomUUID(),
                  companyId: input.companyId,
                  name,
                  role,
                  publicProfileUrl: personInput.publicProfileUrl ?? null,
                  checkedAt,
                  createdAt: now,
                  updatedAt: now
                }).returning()
              : await transaction.update(people).set({
                  name,
                  role,
                  publicProfileUrl: personInput.publicProfileUrl ?? null,
                  checkedAt,
                  updatedAt: now
                }).where(eq(people.id, existing.id)).returning();
            const person = requiredRow(personRow, "person");
            existingByIdentity.set(identity, person);
            refreshedPersonIds.add(person.id);

            const priorDiscoveryEvidence = normalizeRows(await transaction.select().from(evidence).where(and(
              eq(evidence.personId, person.id),
              eq(evidence.factType, "public_role")
            )).orderBy(asc(evidence.sourceUrl), asc(evidence.id)));
            const unmatchedEvidence = new Set(priorDiscoveryEvidence.map((item) => item.id));
            const refreshedEvidence: Evidence[] = [];
            for (const evidenceInput of personInput.evidence) {
              const evidenceCheckedAt = assertIsoTimestamp(
                "evidence.checkedAt",
                evidenceInput.checkedAt
              );
              const prior = priorDiscoveryEvidence.find((item) => {
                return unmatchedEvidence.has(item.id)
                  && item.sourceUrl === evidenceInput.sourceUrl
                  && item.factType === (evidenceInput.factType ?? null);
              });
              const [rowResult] = prior === undefined
                ? await transaction.insert(evidence).values({
                    id: randomUUID(),
                    personId: person.id,
                    sourceUrl: evidenceInput.sourceUrl,
                    title: evidenceInput.title ?? null,
                    factType: evidenceInput.factType ?? null,
                    fact: evidenceInput.fact,
                    checkedAt: evidenceCheckedAt,
                    confidence: evidenceInput.confidence,
                    createdAt: nowIso()
                  }).returning()
                : await transaction.update(evidence).set({
                    title: evidenceInput.title ?? null,
                    fact: evidenceInput.fact,
                    checkedAt: evidenceCheckedAt,
                    confidence: evidenceInput.confidence
                  }).where(eq(evidence.id, prior.id)).returning();
              const row = requiredRow(rowResult, "evidence");
              if (prior !== undefined) {
                unmatchedEvidence.delete(prior.id);
              }
              refreshedEvidence.push(row);
            }
            for (const staleEvidenceId of unmatchedEvidence) {
              await transaction.delete(evidence).where(eq(evidence.id, staleEvidenceId));
            }
            refreshed.push({ ...person, evidence: refreshedEvidence });
          }
          if (input.replaceMissingDiscovery === true) {
            for (const existingPerson of existingPeople) {
              if (refreshedPersonIds.has(existingPerson.id)) {
                continue;
              }
              await transaction.delete(evidence).where(and(
                eq(evidence.personId, existingPerson.id),
                eq(evidence.factType, "public_role")
              ));
              await transaction.update(people).set({
                publicProfileUrl: null,
                checkedAt: null,
                updatedAt: nowIso()
              }).where(eq(people.id, existingPerson.id));
            }
          }
          return refreshed;
        });
      }
    },
    evidence: {
      async add(input: EvidenceAddInput): Promise<Evidence> {
        const [row] = await database.insert(evidence).values({
          id: randomUUID(),
          personId: input.personId,
          sourceUrl: input.sourceUrl,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.factType === undefined ? {} : { factType: input.factType }),
          fact: input.fact,
          checkedAt: assertIsoTimestamp("evidence.checkedAt", input.checkedAt),
          confidence: input.confidence,
          createdAt: nowIso()
        }).returning();
        return requiredRow(row, "evidence");
      },
      async get(id: string): Promise<Evidence | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [row] = await database.select().from(evidence).where(eq(evidence.id, id));
        return row === undefined ? undefined : normalizeRowTimestamps(row);
      },
      async listForPerson(personId: string): Promise<Evidence[]> {
        if (!isUuid(personId)) {
          return [];
        }
        const rows = await database.select().from(evidence).where(eq(evidence.personId, personId)).orderBy(
          asc(evidence.checkedAt),
          asc(evidence.id)
        );
        return normalizeRows(rows);
      }
    },
    targets: {
      async upsert(input: TargetUpsertInput): Promise<Target> {
        const now = nowIso();
        const [target] = await database.insert(targets).values({
          id: randomUUID(),
          ...input,
          status: "discovered",
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: targets.personId,
          set: {
            pmmOpportunity: input.pmmOpportunity,
            referralPotential: input.referralPotential,
            networkValue: input.networkValue,
            totalScore: input.totalScore,
            confidence: input.confidence,
            rationale: input.rationale,
            updatedAt: now
          }
        }).returning();
        return requiredRow(target, "target");
      },
      async get(id: string): Promise<Target | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [target] = await database.select().from(targets).where(eq(targets.id, id));
        return target === undefined ? undefined : normalizeRowTimestamps(target);
      },
      async getByPerson(personId: string): Promise<Target | undefined> {
        if (!isUuid(personId)) {
          return undefined;
        }
        const [target] = await database.select().from(targets).where(eq(
          targets.personId,
          personId
        ));
        return target === undefined ? undefined : normalizeRowTimestamps(target);
      },
      async updateStatus(
        id: string,
        expectedStatus: string,
        newStatus: string
      ): Promise<Target | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [target] = await database.update(targets).set({
          status: newStatus,
          updatedAt: nowIso()
        }).where(
          and(eq(targets.id, id), eq(targets.status, expectedStatus))
        ).returning();
        return target === undefined ? undefined : normalizeRowTimestamps(target);
      },
      async list(filter: TargetListFilter = {}): Promise<Target[]> {
        if (filter.companyId !== undefined && !isUuid(filter.companyId)) {
          return [];
        }
        const conditions = [
          ...(filter.companyId === undefined ? [] : [eq(people.companyId, filter.companyId)]),
          ...(filter.status === undefined ? [] : [eq(targets.status, filter.status)])
        ];
        const rows = await database.select({ target: targets }).from(targets).innerJoin(
          people,
          eq(targets.personId, people.id)
        ).innerJoin(
          companies,
          eq(people.companyId, companies.id)
        ).where(and(...conditions)).orderBy(
          asc(companies.name),
          asc(people.name),
          asc(people.role),
          asc(targets.id)
        );
        return rows.map((row) => normalizeRowTimestamps(row.target));
      }
    },
    notes: {
      async add(input: { targetId: string; text: string }): Promise<TargetNote> {
        const [note] = await database.insert(targetNotes).values({
          id: randomUUID(),
          targetId: input.targetId,
          text: input.text,
          createdAt: nowIso()
        }).returning();
        return requiredRow(note, "target note");
      },
      async listForTarget(targetId: string): Promise<TargetNote[]> {
        if (!isUuid(targetId)) {
          return [];
        }
        const rows = await database.select().from(targetNotes).where(
          eq(targetNotes.targetId, targetId)
        ).orderBy(asc(targetNotes.createdAt), sql`${targetNotes}.ctid`);
        return normalizeRows(rows);
      }
    },
    outreachDrafts: {
      async createVersion(input: OutreachDraftVersionInput): Promise<OutreachDraft> {
        return serializableTransaction(database, async (transaction) => {
          await transaction.select({ id: targets.id }).from(targets).where(
            eq(targets.id, input.targetId)
          ).for("update");
          const [latest] = await transaction.select().from(outreachDrafts).where(and(
            eq(outreachDrafts.targetId, input.targetId),
            eq(outreachDrafts.purpose, input.purpose)
          )).orderBy(desc(outreachDrafts.version)).limit(1).for("update");
          const now = nowIso();
          const [row] = await transaction.insert(outreachDrafts).values({
            id: randomUUID(),
            targetId: input.targetId,
            purpose: input.purpose,
            text: input.text,
            version: (latest?.version ?? 0) + 1,
            evidenceIdsJson: input.evidenceIds,
            createdAt: now,
            updatedAt: now
          }).returning();
          return decodeOutreachDraft(requiredRow(row, "outreach draft"));
        }, "outreach_target_purpose_version_unique");
      },
      async getVersion(
        targetId: string,
        purpose: string,
        version: number
      ): Promise<OutreachDraft | undefined> {
        if (!isUuid(targetId)) {
          return undefined;
        }
        const [row] = await database.select().from(outreachDrafts).where(and(
          eq(outreachDrafts.targetId, targetId),
          eq(outreachDrafts.purpose, purpose),
          eq(outreachDrafts.version, version)
        ));
        return row === undefined ? undefined : decodeOutreachDraft(row);
      },
      async listForTarget(targetId: string): Promise<OutreachDraft[]> {
        if (!isUuid(targetId)) {
          return [];
        }
        const rows = await database.select().from(outreachDrafts).where(
          eq(outreachDrafts.targetId, targetId)
        ).orderBy(asc(outreachDrafts.purpose), asc(outreachDrafts.version));
        return rows.map(decodeOutreachDraft);
      }
    },
    shortlists: {
      async create(input: { name: string; targetIds: string[] }): Promise<Shortlist> {
        return database.transaction(async (transaction) => {
          const now = nowIso();
          const [shortlistRow] = await transaction.insert(shortlists).values({
            id: randomUUID(),
            name: input.name,
            createdAt: now,
            updatedAt: now
          }).returning();
          const shortlist = requiredRow(shortlistRow, "shortlist");
          if (input.targetIds.length > 0) {
            await transaction.insert(shortlistEntries).values(input.targetIds.map((targetId, position) => ({
              id: randomUUID(),
              shortlistId: shortlist.id,
              targetId,
              position,
              createdAt: now
            })));
          }
          return shortlist;
        });
      },
      async getWithEntries(id: string): Promise<ShortlistWithEntries | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [shortlist] = await database.select().from(shortlists).where(eq(shortlists.id, id));
        if (shortlist === undefined) {
          return undefined;
        }
        const entries = await database.select().from(shortlistEntries).where(
          eq(shortlistEntries.shortlistId, id)
        ).orderBy(asc(shortlistEntries.position));
        return {
          ...normalizeRowTimestamps(shortlist),
          entries: normalizeRows(entries)
        };
      },
      async list(): Promise<Shortlist[]> {
        const rows = await database.select().from(shortlists).orderBy(
          asc(shortlists.createdAt),
          asc(shortlists.id)
        );
        return normalizeRows(rows);
      }
    },
    postMedia: {
      async create(input: PostMediaCreateInput): Promise<PostMedia> {
        const { createdAt: requestedCreatedAt, ...values } = input;
        const createdAt = requestedCreatedAt === undefined
          ? nowIso()
          : assertIsoTimestamp("postMedia.createdAt", requestedCreatedAt);
        const [media] = await database.insert(postMedia).values({
          ...values,
          createdAt
        }).returning();
        return requiredRow(media, "post media");
      },
      async get(id: string): Promise<PostMedia | undefined> {
        if (!isUuid(id)) {
          return undefined;
        }
        const [media] = await database.select().from(postMedia).where(eq(postMedia.id, id));
        return media === undefined ? undefined : normalizeRowTimestamps(media);
      },
      async getByOwnerAndSha(
        ownerSubject: string,
        sha256: string
      ): Promise<PostMedia | undefined> {
        if (!isUuid(ownerSubject) || !SHA256_PATTERN.test(sha256)) {
          return undefined;
        }
        const [media] = await database.select().from(postMedia).where(and(
          eq(postMedia.ownerSubject, ownerSubject),
          eq(postMedia.sha256, sha256)
        ));
        return media === undefined ? undefined : normalizeRowTimestamps(media);
      },
      async deleteOwnedUnreferenced(
        ownerSubject: string,
        ids: readonly string[]
      ): Promise<string[]> {
        if (
          !isUuid(ownerSubject)
          || ids.length === 0
          || ids.some((id) => !isUuid(id))
        ) {
          return [];
        }
        const rows = await database.delete(postMedia).where(and(
          eq(postMedia.ownerSubject, ownerSubject),
          inArray(postMedia.id, [...ids]),
          notExists(database.select({ id: postDraftMedia.mediaId }).from(postDraftMedia).where(
            eq(postDraftMedia.mediaId, postMedia.id)
          ))
        )).returning({ id: postMedia.id });
        return rows.map(({ id }) => id);
      }
    },
    postDraftMedia: {
      async listForVersion(
        postDraftId: string,
        version: number
      ): Promise<PostDraftMediaWithMetadata[]> {
        if (!isUuid(postDraftId) || !Number.isInteger(version)) {
          return [];
        }
        return listPostDraftMediaForVersion(database, postDraftId, version);
      }
    },
    postDrafts: {
      async createVersion(input: PostDraftVersionInput): Promise<PostDraft> {
        const draftId = input.draftId ?? randomUUID();
        return serializableTransaction(database, async (transaction) => {
          const [latest] = await transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, draftId)
          ).orderBy(desc(postDrafts.version)).limit(1).for("update");
          const version = (latest?.version ?? 0) + 1;
          const now = nowIso();
          const [post] = await transaction.insert(postDrafts).values({
            id: randomUUID(),
            draftId,
            text: input.text,
            visibility: input.visibility,
            version,
            checksum: typeof input.checksum === "function"
              ? input.checksum(version)
              : input.checksum,
            state: input.state,
            createdAt: now,
            updatedAt: now
          }).returning();
          return requiredRow(post, "post draft");
        }, "post_draft_version_unique");
      },
      async createVersionWithMedia(
        input: PostDraftVersionWithMediaInput
      ): Promise<{ post: PostDraft; media: PostDraftMediaWithMetadata[] }> {
        if (input.media.length > 0 && (input.ownerSubject === undefined || !isUuid(input.ownerSubject))) {
          throw new Error("ownerSubject must be a valid UUID");
        }
        if (input.media.length > 4) {
          throw new Error("A post draft version can contain at most four media items");
        }
        if (input.media.some(({ mediaId }) => !isUuid(mediaId))) {
          throw new Error("Every mediaId must be a valid UUID");
        }
        const normalizedMediaIds = input.media.map(({ mediaId }) => mediaId.toLowerCase());
        if (new Set(normalizedMediaIds).size !== normalizedMediaIds.length) {
          throw new Error("A post draft version cannot contain duplicate media items");
        }
        const draftId = input.draftId ?? randomUUID();
        const sortedMediaIds = [...normalizedMediaIds].sort();
        return serializableTransaction(database, async (transaction) => {
          const [latest] = await transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, draftId)
          ).orderBy(desc(postDrafts.version)).limit(1).for("update");
          if (
            input.expectedVersion !== undefined
            && latest?.version !== input.expectedVersion
          ) {
            throw new PostDraftVersionConflictError();
          }
          const lockedMedia = sortedMediaIds.length === 0
            ? []
            : await transaction.select({
                id: postMedia.id,
                ownerSubject: postMedia.ownerSubject,
                objectPath: postMedia.objectPath,
                sha256: postMedia.sha256,
                mimeType: postMedia.mimeType,
                byteSize: postMedia.byteSize,
                width: postMedia.width,
                height: postMedia.height,
                frameCount: postMedia.frameCount,
                originalFilename: postMedia.originalFilename,
                createdAt: postMedia.createdAt
              }).from(postMedia).where(
                inArray(postMedia.id, sortedMediaIds)
              ).orderBy(asc(postMedia.id)).for("update");
          if (
            lockedMedia.length !== sortedMediaIds.length
            || lockedMedia.some(({ ownerSubject }) => (
              ownerSubject.toLowerCase() !== input.ownerSubject?.toLowerCase()
            ))
          ) {
            throw new Error("Every media item must exist and be owned by the request subject");
          }
          const version = (latest?.version ?? 0) + 1;
          const now = nowIso();
          const lockedById = new Map(lockedMedia.map((media) => [media.id.toLowerCase(), media]));
          const checksumMedia = input.media.map((item, position) => {
            const media = lockedById.get(item.mediaId.toLowerCase());
            if (media === undefined) {
              throw new Error("Every media item must exist and be owned by the request subject");
            }
            return {
              position,
              sha256: media.sha256,
              mimeType: media.mimeType,
              altText: item.altText
            };
          });
          const [postRow] = await transaction.insert(postDrafts).values({
            id: randomUUID(),
            draftId,
            text: input.text,
            visibility: input.visibility,
            version,
            checksum: typeof input.checksum === "function"
              ? input.checksum(version, draftId, checksumMedia)
              : input.checksum,
            state: input.state,
            createdAt: now,
            updatedAt: now
          }).returning();
          const post = requiredRow(postRow, "post draft");
          if (input.media.length > 0) {
            await transaction.insert(postDraftMedia).values(input.media.map((media, position) => ({
              postDraftId: post.id,
              version: post.version,
              position,
              mediaId: media.mediaId,
              altText: media.altText
            })));
          }
          return {
            post,
            media: await listPostDraftMediaForVersion(transaction, post.id, post.version)
          };
        }, "post_draft_version_unique");
      },
      async getVersion(draftId: string, version: number): Promise<PostDraft | undefined> {
        if (!isUuid(draftId)) {
          return undefined;
        }
        const [post] = await database.select().from(postDrafts).where(and(
          eq(postDrafts.draftId, draftId),
          eq(postDrafts.version, version)
        ));
        return post === undefined ? undefined : normalizeRowTimestamps(post);
      },
      async listVersions(draftId: string): Promise<PostDraft[]> {
        if (!isUuid(draftId)) {
          return [];
        }
        const rows = await database.select().from(postDrafts).where(eq(postDrafts.draftId, draftId)).orderBy(
          asc(postDrafts.version)
        );
        return normalizeRows(rows);
      },
      async transitionState(input: {
        versionId: string;
        version: number;
        expectedState: string;
        nextState: string;
      }): Promise<PostDraft | undefined> {
        if (!isUuid(input.versionId)) {
          return undefined;
        }
        const [post] = await database.update(postDrafts).set({
          state: input.nextState,
          updatedAt: nowIso()
        }).where(and(
          eq(postDrafts.id, input.versionId),
          eq(postDrafts.version, input.version),
          eq(postDrafts.state, input.expectedState)
        )).returning();
        return post === undefined ? undefined : normalizeRowTimestamps(post);
      }
    },
    previews: {
      async create(
        input: Omit<typeof postPreviews.$inferInsert, "id" | "consumedAt">
      ): Promise<PostPreview> {
        const [preview] = await database.insert(postPreviews).values({
          id: randomUUID(),
          ...input,
          expiresAt: assertIsoTimestamp("preview.expiresAt", input.expiresAt)
        }).returning();
        return requiredRow(preview, "post preview");
      },
      async getByTokenHash(tokenHash: string): Promise<PostPreview | undefined> {
        const [preview] = await database.select().from(postPreviews).where(
          eq(postPreviews.tokenHash, tokenHash)
        );
        return preview === undefined ? undefined : normalizeRowTimestamps(preview);
      },
      async listForPostDraft(postDraftId: string): Promise<PostPreview[]> {
        if (!isUuid(postDraftId)) {
          return [];
        }
        const rows = await database.select().from(postPreviews).where(
          eq(postPreviews.postDraftId, postDraftId)
        ).orderBy(asc(postPreviews.expiresAt), asc(postPreviews.id));
        return normalizeRows(rows);
      },
      async createForLatest(input: {
        draftId: string;
        version: number;
        tokenHash: string;
        expiresAt: string;
        allowedStates: readonly string[];
        expectedVersionId?: string;
        expectedChecksum?: string;
        replaceUnconsumedAt?: string;
        nextState?: string;
        expectedSnapshot?: ExactPreviewSnapshotExpected;
      }): Promise<PreviewCreationResult> {
        const expiresAt = assertIsoTimestamp("preview.expiresAt", input.expiresAt);
        const replaceUnconsumedAt = input.replaceUnconsumedAt === undefined
          ? undefined
          : assertIsoTimestamp("preview.replaceUnconsumedAt", input.replaceUnconsumedAt);
        if (!isUuid(input.draftId)) {
          return { outcome: "not_found" };
        }
        return serializableTransaction(database, async (transaction) => {
          const [latest] = await transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, input.draftId)
          ).orderBy(desc(postDrafts.version)).limit(1).for("update");
          if (latest === undefined) {
            return { outcome: "not_found" };
          }
          const [postRow] = latest.version === input.version
            ? [latest]
            : await transaction.select().from(postDrafts).where(and(
                eq(postDrafts.draftId, input.draftId),
                eq(postDrafts.version, input.version)
              ));
          if (postRow === undefined) {
            return { outcome: "not_found" };
          }
          const post = normalizeRowTimestamps(postRow);
          if (latest.id !== post.id) {
            return { outcome: "not_latest" };
          }
          if (
            (input.expectedVersionId !== undefined && input.expectedVersionId !== post.id)
            || (input.expectedChecksum !== undefined && input.expectedChecksum !== post.checksum)
          ) {
            return { outcome: "integrity_mismatch" };
          }
          if (input.expectedSnapshot !== undefined) {
            const lockedMedia = await lockPostDraftMediaForVersion(
              transaction,
              post.id,
              post.version
            );
            if (!exactPreviewSnapshotMatches(post, lockedMedia, input.expectedSnapshot)) {
              return { outcome: "integrity_mismatch" };
            }
          }
          if (!input.allowedStates.includes(post.state)) {
            return { outcome: "invalid_state" };
          }
          if (replaceUnconsumedAt !== undefined) {
            await transaction.update(postPreviews).set({
              consumedAt: replaceUnconsumedAt
            }).where(and(
              eq(postPreviews.postDraftId, post.id),
              eq(postPreviews.version, post.version),
              isNull(postPreviews.consumedAt)
            ));
          }
          const [previewRow] = await transaction.insert(postPreviews).values({
            id: randomUUID(),
            postDraftId: post.id,
            version: post.version,
            tokenHash: input.tokenHash,
            expiresAt
          }).returning();
          const preview = requiredRow(previewRow, "post preview");
          if (input.nextState === undefined || input.nextState === post.state) {
            return { outcome: "created", post, preview };
          }
          const [updatedPostRow] = await transaction.update(postDrafts).set({
            state: input.nextState,
            updatedAt: replaceUnconsumedAt ?? nowIso()
          }).where(and(
            eq(postDrafts.id, post.id),
            eq(postDrafts.version, post.version),
            eq(postDrafts.state, post.state)
          )).returning();
          if (updatedPostRow === undefined) {
            throw new Error("Post draft state changed before preview creation completed");
          }
          return {
            outcome: "created",
            post: normalizeRowTimestamps(updatedPostRow),
            preview
          };
        });
      },
      async consumeExact(input: {
        tokenHash: string;
        consumedAt: string;
        expected: PreviewExpectedRow;
        allowedStates: readonly string[];
        claimState?: string;
      }): Promise<PreviewConsumptionResult> {
        const consumedAt = assertIsoTimestamp("preview.consumedAt", input.consumedAt);
        return serializableTransaction(database, async (transaction) => consumePreviewExact(
          transaction,
          { ...input, consumedAt }
        ));
      },
      async consume(tokenHash: string, consumedAt: string): Promise<PostPreview | undefined> {
        assertIsoTimestamp("preview.consumedAt", consumedAt);
        return database.transaction(async (transaction) => {
          const [preview] = await transaction.update(postPreviews).set({ consumedAt }).where(and(
            eq(postPreviews.tokenHash, tokenHash),
            isNull(postPreviews.consumedAt)
          )).returning();
          return preview === undefined ? undefined : normalizeRowTimestamps(preview);
        });
      }
    },
    publishAttemptMedia: {
      async listForAttempt(attemptId: string): Promise<PublishAttemptMedia[]> {
        if (!isUuid(attemptId)) {
          return [];
        }
        const rows = await database.select().from(publishAttemptMedia).where(
          eq(publishAttemptMedia.publishAttemptId, attemptId)
        ).orderBy(asc(publishAttemptMedia.position), asc(publishAttemptMedia.id));
        return normalizeRows(rows);
      },
      async updateState(
        input: PublishAttemptMediaUpdateInput
      ): Promise<PublishAttemptMedia | undefined> {
        if (!isUuid(input.id)) {
          return undefined;
        }
        const conditions = [eq(publishAttemptMedia.id, input.id)];
        if (input.expectedState !== undefined) {
          conditions.push(eq(publishAttemptMedia.state, input.expectedState));
        }
        const [row] = await database.update(publishAttemptMedia).set({
          state: input.state,
          ...(input.linkedinImageUrn === undefined
            ? {}
            : { linkedinImageUrn: input.linkedinImageUrn })
        }).where(and(...conditions)).returning();
        return row === undefined ? undefined : normalizeRowTimestamps(row);
      }
    },
    publishAttempts: {
      record: recordPublishAttempt,
      async updateResult(id: string, input: {
        responseCategory: string;
        postUrn?: string;
        sanitizedError?: string;
        completedAt: string;
      }): Promise<PublishAttempt | undefined> {
        assertIsoTimestamp("publishAttempt.completedAt", input.completedAt);
        if (!isUuid(id)) {
          return undefined;
        }
        const [attempt] = await database.update(publishAttempts).set({
          responseCategory: input.responseCategory,
          ...(input.postUrn === undefined ? {} : { postUrn: input.postUrn }),
          ...(input.sanitizedError === undefined ? {} : { sanitizedError: input.sanitizedError }),
          completedAt: input.completedAt
        }).where(eq(publishAttempts.id, id)).returning();
        return attempt === undefined ? undefined : normalizeRowTimestamps(attempt);
      },
      async listForPostDraft(postDraftId: string): Promise<PublishAttempt[]> {
        if (!isUuid(postDraftId)) {
          return [];
        }
        const rows = await database.select().from(publishAttempts).where(
          eq(publishAttempts.postDraftId, postDraftId)
        ).orderBy(asc(publishAttempts.requestedAt), asc(publishAttempts.id));
        return normalizeRows(rows);
      }
    },
    oauthTokens: {
      async upsert(input: {
        provider: string;
        ciphertext: string;
        refreshMetadataCiphertext?: string;
        expiresAt?: string;
      }): Promise<OAuthToken> {
        const now = nowIso();
        const expiresAt = input.expiresAt === undefined
          ? undefined
          : assertIsoTimestamp("oauthToken.expiresAt", input.expiresAt);
        await database.insert(oauthTokens).values({
          id: randomUUID(),
          provider: input.provider,
          ciphertext: input.ciphertext,
          ...(input.refreshMetadataCiphertext === undefined
            ? {}
            : { refreshMetadataCiphertext: input.refreshMetadataCiphertext }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          createdAt: now,
          updatedAt: now
        }).onConflictDoUpdate({
          target: oauthTokens.provider,
          set: {
            ciphertext: input.ciphertext,
            refreshMetadataCiphertext: input.refreshMetadataCiphertext ?? null,
            expiresAt: expiresAt ?? null,
            updatedAt: now
          }
        });
        const [token] = await database.select().from(oauthTokens).where(
          eq(oauthTokens.provider, input.provider)
        );
        return requiredRow(token, "OAuth token");
      },
      async getByProvider(provider: string): Promise<OAuthToken | undefined> {
        const [token] = await database.select().from(oauthTokens).where(
          eq(oauthTokens.provider, provider)
        );
        return token === undefined ? undefined : normalizeRowTimestamps(token);
      }
    }
  };
}
