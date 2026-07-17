import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, isNull, max, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  companies,
  evidence,
  oauthTokens,
  outreachDrafts,
  people,
  postDrafts,
  postPreviews,
  publishAttempts,
  schema,
  settings,
  shortlistEntries,
  shortlists,
  targetNotes,
  targets
} from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

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
export type PostDraft = typeof postDrafts.$inferSelect;
export type PostPreview = typeof postPreviews.$inferSelect;
export type PublishAttempt = typeof publishAttempts.$inferSelect;
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
  status: string;
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

export type PreviewExpectedRow = {
  postId: string;
  versionId: string;
  version: number;
  checksum: string;
  visibility: string;
};

export type PreviewCreationResult =
  | { outcome: "created"; post: PostDraft; preview: PostPreview }
  | { outcome: "not_found" | "not_latest" | "invalid_state" };

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

function decodeOutreachDraft(row: OutreachDraftRow): OutreachDraft {
  const { evidenceIdsJson, ...draft } = row;
  return { ...draft, evidenceIds: JSON.parse(evidenceIdsJson) as string[] };
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

export function createRepositories(database: Database) {
  return {
    settings: {
      set(key: string, value: unknown): Setting {
        const updatedAt = nowIso();
        return database.insert(settings).values({
          id: randomUUID(),
          key,
          valueJson: JSON.stringify(value),
          updatedAt
        }).onConflictDoUpdate({
          target: settings.key,
          set: { valueJson: JSON.stringify(value), updatedAt }
        }).returning().get();
      },
      get<T = unknown>(key: string): T | undefined {
        const setting = database.select().from(settings).where(eq(settings.key, key)).get();
        return setting === undefined ? undefined : JSON.parse(setting.valueJson) as T;
      }
    },
    companies: {
      upsert(input: CompanyUpsertInput): Company {
        const now = nowIso();
        const checkedAt = input.checkedAt === undefined
          ? undefined
          : assertIsoTimestamp("company.checkedAt", input.checkedAt);
        database.insert(companies).values({
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
        }).run();
        return database.select().from(companies).where(eq(companies.ycId, input.ycId)).get()!;
      },
      get(id: string): Company | undefined {
        return database.select().from(companies).where(eq(companies.id, id)).get();
      },
      getByYcId(ycId: string): Company | undefined {
        return database.select().from(companies).where(eq(companies.ycId, ycId)).get();
      },
      list(): Company[] {
        return database.select().from(companies).orderBy(asc(companies.name), asc(companies.id)).all();
      }
    },
    people: {
      upsert(input: PersonUpsertInput): Person {
        const now = nowIso();
        const checkedAt = input.checkedAt === undefined
          ? undefined
          : assertIsoTimestamp("person.checkedAt", input.checkedAt);
        database.insert(people).values({
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
        }).run();
        return database.select().from(people).where(and(
          eq(people.companyId, input.companyId),
          eq(people.name, input.name),
          eq(people.role, input.role)
        )).get()!;
      },
      get(id: string): Person | undefined {
        return database.select().from(people).where(eq(people.id, id)).get();
      },
      listByCompany(companyId: string): Person[] {
        return database.select().from(people).where(eq(people.companyId, companyId)).orderBy(
          asc(people.name),
          asc(people.role)
        ).all();
      },
      getWithEvidence(id: string): PersonWithEvidence | undefined {
        const person = database.select().from(people).where(eq(people.id, id)).get();
        if (person === undefined) {
          return undefined;
        }
        return {
          ...person,
          evidence: database.select().from(evidence).where(eq(evidence.personId, id)).orderBy(
            asc(evidence.checkedAt),
            asc(evidence.id)
          ).all()
        };
      },
      refreshDiscovery(input: CompanyPersonDiscoveryRefreshInput): PersonWithEvidence[] {
        return database.transaction((transaction) => {
          const existingPeople = transaction.select().from(people).where(
            eq(people.companyId, input.companyId)
          ).orderBy(asc(people.name), asc(people.role), asc(people.id)).all();
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
            const person = existing === undefined
              ? transaction.insert(people).values({
                  id: randomUUID(),
                  companyId: input.companyId,
                  name,
                  role,
                  publicProfileUrl: personInput.publicProfileUrl ?? null,
                  checkedAt,
                  createdAt: now,
                  updatedAt: now
                }).returning().get()
              : transaction.update(people).set({
                  name,
                  role,
                  publicProfileUrl: personInput.publicProfileUrl ?? null,
                  checkedAt,
                  updatedAt: now
                }).where(eq(people.id, existing.id)).returning().get()!;
            existingByIdentity.set(identity, person);
            refreshedPersonIds.add(person.id);

            const priorDiscoveryEvidence = transaction.select().from(evidence).where(and(
              eq(evidence.personId, person.id),
              eq(evidence.factType, "public_role")
            )).orderBy(asc(evidence.sourceUrl), asc(evidence.id)).all();
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
              const row = prior === undefined
                ? transaction.insert(evidence).values({
                    id: randomUUID(),
                    personId: person.id,
                    sourceUrl: evidenceInput.sourceUrl,
                    title: evidenceInput.title ?? null,
                    factType: evidenceInput.factType ?? null,
                    fact: evidenceInput.fact,
                    checkedAt: evidenceCheckedAt,
                    confidence: evidenceInput.confidence,
                    createdAt: nowIso()
                  }).returning().get()
                : transaction.update(evidence).set({
                    title: evidenceInput.title ?? null,
                    fact: evidenceInput.fact,
                    checkedAt: evidenceCheckedAt,
                    confidence: evidenceInput.confidence
                  }).where(eq(evidence.id, prior.id)).returning().get()!;
              if (prior !== undefined) {
                unmatchedEvidence.delete(prior.id);
              }
              refreshedEvidence.push(row);
            }
            for (const staleEvidenceId of unmatchedEvidence) {
              transaction.delete(evidence).where(eq(evidence.id, staleEvidenceId)).run();
            }
            refreshed.push({ ...person, evidence: refreshedEvidence });
          }
          if (input.replaceMissingDiscovery === true) {
            for (const existingPerson of existingPeople) {
              if (refreshedPersonIds.has(existingPerson.id)) {
                continue;
              }
              transaction.delete(evidence).where(and(
                eq(evidence.personId, existingPerson.id),
                eq(evidence.factType, "public_role")
              )).run();
              transaction.update(people).set({
                publicProfileUrl: null,
                checkedAt: null,
                updatedAt: nowIso()
              }).where(eq(people.id, existingPerson.id)).run();
            }
          }
          return refreshed;
        });
      }
    },
    evidence: {
      add(input: EvidenceAddInput): Evidence {
        return database.insert(evidence).values({
          id: randomUUID(),
          personId: input.personId,
          sourceUrl: input.sourceUrl,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.factType === undefined ? {} : { factType: input.factType }),
          fact: input.fact,
          checkedAt: assertIsoTimestamp("evidence.checkedAt", input.checkedAt),
          confidence: input.confidence,
          createdAt: nowIso()
        }).returning().get();
      },
      get(id: string): Evidence | undefined {
        return database.select().from(evidence).where(eq(evidence.id, id)).get();
      },
      listForPerson(personId: string): Evidence[] {
        return database.select().from(evidence).where(eq(evidence.personId, personId)).orderBy(
          asc(evidence.checkedAt),
          asc(evidence.id)
        ).all();
      }
    },
    targets: {
      upsert(input: TargetUpsertInput): Target {
        const now = nowIso();
        database.insert(targets).values({
          id: randomUUID(),
          ...input,
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
            status: input.status,
            rationale: input.rationale,
            updatedAt: now
          }
        }).run();
        return database.select().from(targets).where(eq(targets.personId, input.personId)).get()!;
      },
      get(id: string): Target | undefined {
        return database.select().from(targets).where(eq(targets.id, id)).get();
      },
      getByPerson(personId: string): Target | undefined {
        return database.select().from(targets).where(eq(targets.personId, personId)).get();
      },
      updateStatus(id: string, status: string): Target | undefined {
        return database.update(targets).set({ status, updatedAt: nowIso() }).where(
          eq(targets.id, id)
        ).returning().get();
      },
      list(filter: TargetListFilter = {}): Target[] {
        const conditions = [
          ...(filter.companyId === undefined ? [] : [eq(people.companyId, filter.companyId)]),
          ...(filter.status === undefined ? [] : [eq(targets.status, filter.status)])
        ];
        return database.select({ target: targets }).from(targets).innerJoin(
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
        ).all().map(
          (row) => row.target
        );
      }
    },
    notes: {
      add(input: { targetId: string; text: string }): TargetNote {
        return database.insert(targetNotes).values({
          id: randomUUID(),
          targetId: input.targetId,
          text: input.text,
          createdAt: nowIso()
        }).returning().get();
      },
      listForTarget(targetId: string): TargetNote[] {
        return database.select().from(targetNotes).where(eq(targetNotes.targetId, targetId)).orderBy(
          sql`${targetNotes}.rowid`
        ).all();
      }
    },
    outreachDrafts: {
      createVersion(input: OutreachDraftVersionInput): OutreachDraft {
        return database.transaction((transaction) => {
          const latest = transaction.select({ version: max(outreachDrafts.version) }).from(
            outreachDrafts
          ).where(and(
            eq(outreachDrafts.targetId, input.targetId),
            eq(outreachDrafts.purpose, input.purpose)
          )).get();
          const now = nowIso();
          const row = transaction.insert(outreachDrafts).values({
            id: randomUUID(),
            targetId: input.targetId,
            purpose: input.purpose,
            text: input.text,
            version: (latest?.version ?? 0) + 1,
            evidenceIdsJson: JSON.stringify(input.evidenceIds),
            createdAt: now,
            updatedAt: now
          }).returning().get();
          return decodeOutreachDraft(row);
        });
      },
      getVersion(targetId: string, purpose: string, version: number): OutreachDraft | undefined {
        const row = database.select().from(outreachDrafts).where(and(
          eq(outreachDrafts.targetId, targetId),
          eq(outreachDrafts.purpose, purpose),
          eq(outreachDrafts.version, version)
        )).get();
        return row === undefined ? undefined : decodeOutreachDraft(row);
      },
      listForTarget(targetId: string): OutreachDraft[] {
        return database.select().from(outreachDrafts).where(
          eq(outreachDrafts.targetId, targetId)
        ).orderBy(asc(outreachDrafts.purpose), asc(outreachDrafts.version)).all().map(
          decodeOutreachDraft
        );
      }
    },
    shortlists: {
      create(input: { name: string; targetIds: string[] }): Shortlist {
        return database.transaction((transaction) => {
          const now = nowIso();
          const shortlist = transaction.insert(shortlists).values({
            id: randomUUID(),
            name: input.name,
            createdAt: now,
            updatedAt: now
          }).returning().get();
          if (input.targetIds.length > 0) {
            transaction.insert(shortlistEntries).values(input.targetIds.map((targetId, position) => ({
              id: randomUUID(),
              shortlistId: shortlist.id,
              targetId,
              position,
              createdAt: now
            }))).run();
          }
          return shortlist;
        });
      },
      getWithEntries(id: string): ShortlistWithEntries | undefined {
        const shortlist = database.select().from(shortlists).where(eq(shortlists.id, id)).get();
        if (shortlist === undefined) {
          return undefined;
        }
        return {
          ...shortlist,
          entries: database.select().from(shortlistEntries).where(
            eq(shortlistEntries.shortlistId, id)
          ).orderBy(asc(shortlistEntries.position)).all()
        };
      },
      list(): Shortlist[] {
        return database.select().from(shortlists).orderBy(
          asc(shortlists.createdAt),
          asc(shortlists.id)
        ).all();
      }
    },
    postDrafts: {
      createVersion(input: PostDraftVersionInput): PostDraft {
        return database.transaction((transaction) => {
          const draftId = input.draftId ?? randomUUID();
          const latest = transaction.select({ version: max(postDrafts.version) }).from(
            postDrafts
          ).where(eq(postDrafts.draftId, draftId)).get();
          const version = (latest?.version ?? 0) + 1;
          const now = nowIso();
          return transaction.insert(postDrafts).values({
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
          }).returning().get();
        });
      },
      getVersion(draftId: string, version: number): PostDraft | undefined {
        return database.select().from(postDrafts).where(and(
          eq(postDrafts.draftId, draftId),
          eq(postDrafts.version, version)
        )).get();
      },
      listVersions(draftId: string): PostDraft[] {
        return database.select().from(postDrafts).where(eq(postDrafts.draftId, draftId)).orderBy(
          asc(postDrafts.version)
        ).all();
      },
      transitionState(input: {
        versionId: string;
        version: number;
        expectedState: string;
        nextState: string;
      }): PostDraft | undefined {
        return database.update(postDrafts).set({
          state: input.nextState,
          updatedAt: nowIso()
        }).where(and(
          eq(postDrafts.id, input.versionId),
          eq(postDrafts.version, input.version),
          eq(postDrafts.state, input.expectedState)
        )).returning().get();
      }
    },
    previews: {
      create(input: Omit<typeof postPreviews.$inferInsert, "id" | "consumedAt">): PostPreview {
        return database.insert(postPreviews).values({
          id: randomUUID(),
          ...input,
          expiresAt: assertIsoTimestamp("preview.expiresAt", input.expiresAt)
        }).returning().get();
      },
      getByTokenHash(tokenHash: string): PostPreview | undefined {
        return database.select().from(postPreviews).where(eq(postPreviews.tokenHash, tokenHash)).get();
      },
      listForPostDraft(postDraftId: string): PostPreview[] {
        return database.select().from(postPreviews).where(
          eq(postPreviews.postDraftId, postDraftId)
        ).orderBy(sql`${postPreviews}.rowid`).all();
      },
      createForLatest(input: {
        draftId: string;
        version: number;
        tokenHash: string;
        expiresAt: string;
        allowedStates: readonly string[];
      }): PreviewCreationResult {
        const expiresAt = assertIsoTimestamp("preview.expiresAt", input.expiresAt);
        return database.transaction((transaction) => {
          const post = transaction.select().from(postDrafts).where(and(
            eq(postDrafts.draftId, input.draftId),
            eq(postDrafts.version, input.version)
          )).get();
          if (post === undefined) {
            return { outcome: "not_found" };
          }
          const latest = transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, input.draftId)
          ).orderBy(desc(postDrafts.version)).get();
          if (latest === undefined || latest.id !== post.id) {
            return { outcome: "not_latest" };
          }
          if (!input.allowedStates.includes(post.state)) {
            return { outcome: "invalid_state" };
          }
          const preview = transaction.insert(postPreviews).values({
            id: randomUUID(),
            postDraftId: post.id,
            version: post.version,
            tokenHash: input.tokenHash,
            expiresAt
          }).returning().get();
          return { outcome: "created", post, preview };
        });
      },
      consumeExact(input: {
        tokenHash: string;
        consumedAt: string;
        expected: PreviewExpectedRow;
        allowedStates: readonly string[];
        claimState?: string;
      }): PreviewConsumptionResult {
        const consumedAt = assertIsoTimestamp("preview.consumedAt", input.consumedAt);
        return database.transaction((transaction) => {
          const preview = transaction.select().from(postPreviews).where(
            eq(postPreviews.tokenHash, input.tokenHash)
          ).get();
          if (
            preview === undefined
            || !timingSafeTextEqual(preview.tokenHash, input.tokenHash)
          ) {
            return { outcome: "not_found" };
          }
          if (preview.consumedAt !== null) {
            return { outcome: "already_consumed" };
          }
          if (consumedAt >= preview.expiresAt) {
            return { outcome: "expired" };
          }
          const post = transaction.select().from(postDrafts).where(and(
            eq(postDrafts.id, preview.postDraftId),
            eq(postDrafts.version, preview.version)
          )).get();
          if (post === undefined) {
            return { outcome: "stale" };
          }
          if (
            input.expected.postId !== post.draftId
            || input.expected.versionId !== post.id
            || input.expected.version !== post.version
            || input.expected.checksum !== post.checksum
            || input.expected.visibility !== post.visibility
          ) {
            return { outcome: "mismatch" };
          }
          const latest = transaction.select().from(postDrafts).where(
            eq(postDrafts.draftId, post.draftId)
          ).orderBy(desc(postDrafts.version)).get();
          if (latest === undefined || latest.id !== post.id) {
            return { outcome: "stale" };
          }
          if (!input.allowedStates.includes(post.state)) {
            return { outcome: "invalid_state" };
          }
          const consumed = transaction.update(postPreviews).set({ consumedAt }).where(and(
            eq(postPreviews.id, preview.id),
            isNull(postPreviews.consumedAt)
          )).returning().get();
          if (consumed === undefined) {
            return { outcome: "race" };
          }
          if (input.claimState !== undefined) {
            const claimed = transaction.update(postDrafts).set({
              state: input.claimState,
              updatedAt: nowIso()
            }).where(and(
              eq(postDrafts.id, post.id),
              eq(postDrafts.version, post.version),
              eq(postDrafts.state, post.state)
            )).returning().get();
            if (claimed === undefined) {
              throw new Error("Publish claim state changed before preview consumption completed");
            }
          }
          return { outcome: "consumed", post, preview: consumed };
        });
      },
      consume(tokenHash: string, consumedAt: string): PostPreview | undefined {
        assertIsoTimestamp("preview.consumedAt", consumedAt);
        return database.transaction((transaction) => transaction.update(postPreviews).set({
          consumedAt
        }).where(and(
          eq(postPreviews.tokenHash, tokenHash),
          isNull(postPreviews.consumedAt)
        )).returning().get());
      }
    },
    publishAttempts: {
      record(input: Omit<typeof publishAttempts.$inferInsert, "id">): PublishAttempt {
        assertIsoTimestamp("publishAttempt.requestedAt", input.requestedAt);
        if (input.completedAt !== undefined && input.completedAt !== null) {
          assertIsoTimestamp("publishAttempt.completedAt", input.completedAt);
        }
        return database.transaction((transaction) => transaction.insert(publishAttempts).values({
          id: randomUUID(),
          ...input
        }).returning().get());
      },
      updateResult(id: string, input: {
        responseCategory: string;
        postUrn?: string;
        sanitizedError?: string;
        completedAt: string;
      }): PublishAttempt | undefined {
        assertIsoTimestamp("publishAttempt.completedAt", input.completedAt);
        return database.update(publishAttempts).set({
          responseCategory: input.responseCategory,
          ...(input.postUrn === undefined ? {} : { postUrn: input.postUrn }),
          ...(input.sanitizedError === undefined ? {} : { sanitizedError: input.sanitizedError }),
          completedAt: input.completedAt
        }).where(eq(publishAttempts.id, id)).returning().get();
      },
      listForPostDraft(postDraftId: string): PublishAttempt[] {
        return database.select().from(publishAttempts).where(
          eq(publishAttempts.postDraftId, postDraftId)
        ).orderBy(asc(publishAttempts.requestedAt), asc(publishAttempts.id)).all();
      }
    },
    oauthTokens: {
      upsert(input: {
        provider: string;
        ciphertext: string;
        refreshMetadataCiphertext?: string;
        expiresAt?: string;
      }): OAuthToken {
        const now = nowIso();
        const expiresAt = input.expiresAt === undefined
          ? undefined
          : assertIsoTimestamp("oauthToken.expiresAt", input.expiresAt);
        database.insert(oauthTokens).values({
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
        }).run();
        return database.select().from(oauthTokens).where(
          eq(oauthTokens.provider, input.provider)
        ).get()!;
      },
      getByProvider(provider: string): OAuthToken | undefined {
        return database.select().from(oauthTokens).where(eq(oauthTokens.provider, provider)).get();
      }
    }
  };
}
