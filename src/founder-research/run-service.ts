import type { CareerDatabase } from "../db/client.js";
import type {
  Company,
  FounderResearchRun,
  FounderResearchRunItem,
  PersonWithEvidence as StoredPersonWithEvidence
} from "../db/repositories.js";
import { DomainError } from "../domain/errors.js";
import {
  DiscoveryDeadlineError
} from "../research/discovery-deadline.js";
import type { PeopleDiscoveryService } from "../research/people-discovery.js";
import type {
  CompanyResult,
  CompanySearchQuery,
  Evidence,
  PersonWithEvidence
} from "../research/types.js";
import { validateFounderRole } from "./founder-role.js";
import { validateNonFetchingLinkedInProfileUrl } from "./profile-url.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNSAFE_CONTROL = /[\p{Cc}\p{Cf}]/u;
const UNSAFE_CONTROL_GLOBAL = /[\p{Cc}\p{Cf}]/gu;
const WHITESPACE = /\s+/gu;
const PROMPT_INJECTION_PATTERN =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instructions?|rules?|prompt)\b|\b(?:system|developer)\s+prompt\b|\btool\s+call\b/iu;
const FRESH_EVIDENCE_MS = 30 * 24 * 60 * 60 * 1_000;
const LEASE_DURATION_MS = 2 * 60 * 1_000;
const MAX_COMPANIES_PER_CALL = 5;
const MAX_DISCOVERY_CONCURRENCY = 2;

const QUERY_LIMITS = Object.freeze({
  batch: 80,
  industry: 160,
  status: 80,
  location: 160,
  keyword: 240
});

const PUBLIC_TASK_LIMITS = Object.freeze({
  companyName: 200,
  personName: 200,
  role: 160,
  query: 500
});

export type FounderPublicSearchTask = Readonly<{
  runItemId: string;
  companyId: string;
  companyName: string;
  officialWebsiteUrl?: string;
  knownPersonId?: string;
  knownFounderName?: string;
  knownFounderRole?: string;
  suggestedQueries: string[];
  reason: "PROFILE_URL_MISSING" | "FOUNDER_NOT_FOUND" | "AMBIGUOUS";
}>;

export type FounderResearchProcessedItem = Readonly<{
  runItemId: string;
  companyId: string;
  leaseAttempt: number;
  state:
    | "COMPLETE"
    | "PARTIAL"
    | "NOT_FOUND"
    | "AMBIGUOUS"
    | "NEEDS_PUBLIC_SEARCH"
    | "FAILED"
    | "STALE_ATTEMPT";
  founderCount: number;
  verifiedProfileCount: number;
  errorCode?: string;
  errorSummary?: string;
}>;

export type FounderResearchStartResult = Readonly<{
  run: FounderResearchRun;
  selectedCompanyIds: string[];
}>;

export type FounderResearchProcessResult = Readonly<{
  run: FounderResearchRun;
  leasedCount: number;
  items: FounderResearchProcessedItem[];
  publicSearchTasks: FounderPublicSearchTask[];
  shouldContinue: boolean;
}>;

export type FounderResearchRunService = Readonly<{
  startRun(
    query: CompanySearchQuery,
    limit: number
  ): Promise<FounderResearchStartResult>;
  processRun(
    runId: string,
    maxCompanies: number
  ): Promise<FounderResearchProcessResult>;
  getRun(runId: string): Promise<FounderResearchRun>;
}>;

type PersistedYcProvider = Readonly<{
  searchYcCompanies(query: CompanySearchQuery): Promise<CompanyResult[]>;
}>;

export type FounderResearchRunDependencies = Readonly<{
  subject: string;
  ycProvider: PersistedYcProvider;
  peopleDiscovery: PeopleDiscoveryService;
  now?: () => Date;
  concurrencyProbe?: (active: number) => void;
}>;

type OfficialFounder = Readonly<{
  person: PersonWithEvidence | StoredPersonWithEvidence;
  normalizedRole: string;
  storedPersonId: string;
  runPersonId: string;
  officialEvidence?: Evidence | StoredPersonWithEvidence["evidence"][number];
  verifiedProfile: boolean;
}>;

function validationError(field: string, reason: string): DomainError {
  return new DomainError(
    "VALIDATION_ERROR",
    "Founder research run input is invalid",
    { field, reason }
  );
}

function notFound(): DomainError {
  return new DomainError(
    "NOT_FOUND",
    "Founder research run was not found",
    { entity: "founder_research_run" }
  );
}

function trustedNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError(
      "DATA_INTEGRITY",
      "Founder research clock is invalid",
      { entity: "founder_research_clock" }
    );
  }
  return value;
}

function normalizeBoundedQueryString(
  field: keyof typeof QUERY_LIMITS,
  value: unknown
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value === "" || value.trim() === "") {
    throw validationError(field, "required_when_present");
  }
  if (UNSAFE_CONTROL.test(value)) {
    throw validationError(field, "unsafe_characters");
  }
  const normalized = value.normalize("NFC").replace(WHITESPACE, " ").trim();
  if (
    Array.from(normalized).length > QUERY_LIMITS[field]
    || Buffer.byteLength(normalized, "utf8") > QUERY_LIMITS[field] * 4
  ) {
    throw validationError(field, "too_long");
  }
  return normalized;
}

function validateQuery(input: CompanySearchQuery): CompanySearchQuery {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("query", "must_be_object");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    "batch",
    "industry",
    "status",
    "location",
    "keyword",
    "hiring"
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw validationError("query", "unknown_field");
  }
  if (record.hiring !== undefined && typeof record.hiring !== "boolean") {
    throw validationError("hiring", "must_be_boolean");
  }
  const batch = normalizeBoundedQueryString("batch", record.batch);
  const industry = normalizeBoundedQueryString("industry", record.industry);
  const status = normalizeBoundedQueryString("status", record.status);
  const location = normalizeBoundedQueryString("location", record.location);
  const keyword = normalizeBoundedQueryString("keyword", record.keyword);
  return {
    ...(batch === undefined ? {} : { batch }),
    ...(industry === undefined ? {} : { industry }),
    ...(status === undefined ? {} : { status }),
    ...(location === undefined ? {} : { location }),
    ...(keyword === undefined ? {} : { keyword }),
    ...(record.hiring === undefined ? {} : { hiring: record.hiring })
  };
}

function validateIntegerRange(
  field: string,
  value: unknown,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw validationError(field, `must_be_${minimum}_through_${maximum}`);
  }
  return value;
}

function safeCompanyResult(result: CompanyResult): boolean {
  return typeof result === "object"
    && result !== null
    && UUID_PATTERN.test(result.id)
    && typeof result.ycId === "string"
    && result.ycId !== ""
    && result.ycId.length <= 240
    && !UNSAFE_CONTROL.test(result.ycId)
    && typeof result.name === "string"
    && result.name.trim() !== ""
    && Array.from(result.name).length <= PUBLIC_TASK_LIMITS.companyName
    && Buffer.byteLength(result.name, "utf8") <= PUBLIC_TASK_LIMITS.companyName * 4
    && !UNSAFE_CONTROL.test(result.name)
    && !PROMPT_INJECTION_PATTERN.test(result.name);
}

function selectCompanies(
  results: readonly CompanyResult[],
  limit: number
): CompanyResult[] {
  const ordered = results
    .filter(safeCompanyResult)
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (
      left.item.name.localeCompare(right.item.name, "en", { sensitivity: "base" })
      || left.item.ycId.localeCompare(right.item.ycId, "en")
      || left.item.id.localeCompare(right.item.id, "en")
      || left.index - right.index
    ));
  const selected: CompanyResult[] = [];
  const seenIds = new Set<string>();
  const seenYcIds = new Set<string>();
  for (const { item } of ordered) {
    const id = item.id.toLowerCase();
    const ycId = item.ycId.normalize("NFC").toLocaleLowerCase("en-US");
    if (seenIds.has(id) || seenYcIds.has(ycId)) {
      continue;
    }
    seenIds.add(id);
    seenYcIds.add(ycId);
    selected.push(item);
    if (selected.length === limit) {
      break;
    }
  }
  return selected;
}

function safeTaskText(value: string, maximum: number): string {
  return value
    .normalize("NFC")
    .replace(UNSAFE_CONTROL_GLOBAL, "")
    .replace(/["`\\<>[\]{}]/gu, " ")
    .replace(/\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:prior|previous)?\s*(?:rules|instructions?)\b/giu, " ")
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, maximum);
}

function safeWebsiteUrl(value: string | null): string | undefined {
  if (value === null || value.length > 2_048 || UNSAFE_CONTROL.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username !== ""
      || url.password !== ""
    ) {
      return undefined;
    }
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function sameOfficialOrigin(sourceUrl: string, websiteUrl: string | null): boolean {
  const official = safeWebsiteUrl(websiteUrl);
  if (official === undefined) {
    return false;
  }
  try {
    const source = new URL(sourceUrl);
    return (source.protocol === "https:" || source.protocol === "http:")
      && source.username === ""
      && source.password === ""
      && source.origin === new URL(official).origin;
  } catch {
    return false;
  }
}

function isFreshTimestamp(value: string | null, now: Date): boolean {
  if (value === null) {
    return false;
  }
  const checked = new Date(value).getTime();
  const current = now.getTime();
  return Number.isFinite(checked)
    && checked <= current + 5 * 60 * 1_000
    && current - checked <= FRESH_EVIDENCE_MS;
}

function founderRole(person: Pick<PersonWithEvidence, "role">): string | undefined {
  const validation = validateFounderRole(person.role);
  return validation.ok ? validation.normalizedRole : undefined;
}

function normalizedPersonName(value: string): string {
  return value.normalize("NFC").replace(WHITESPACE, " ").trim().toLocaleLowerCase("en-US");
}

function confidenceFor(
  person: PersonWithEvidence | StoredPersonWithEvidence
): number {
  const direct = "confidence" in person && typeof person.confidence === "number"
    ? person.confidence
    : undefined;
  const evidenceConfidence = person.evidence[0]?.confidence;
  const value = direct ?? evidenceConfidence ?? 0.9;
  return Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.9;
}

async function currentFreshOfficialFounders(
  database: CareerDatabase,
  company: Company,
  now: Date
): Promise<StoredPersonWithEvidence[] | undefined> {
  const current = await database.people.listByCompany(company.id);
  const founders: StoredPersonWithEvidence[] = [];
  let sawStaleFounder = false;
  for (const person of current) {
    if (founderRole(person) === undefined) {
      continue;
    }
    const full = await database.people.getWithEvidence(person.id);
    if (full === undefined) {
      sawStaleFounder = true;
      continue;
    }
    const officialEvidence = full.evidence.find((item) => (
      item.factType === "public_role"
      && sameOfficialOrigin(item.sourceUrl, company.websiteUrl)
      && isFreshTimestamp(item.checkedAt, now)
    ));
    if (
      officialEvidence === undefined
      || !isFreshTimestamp(full.checkedAt, now)
    ) {
      sawStaleFounder = true;
      continue;
    }
    founders.push(full);
  }
  if (sawStaleFounder || founders.length === 0) {
    return undefined;
  }
  return founders;
}

function publicSearchQueries(input: {
  companyName: string;
  founderName?: string;
}): string[] {
  const companyName = safeTaskText(
    input.companyName,
    PUBLIC_TASK_LIMITS.companyName
  );
  const founderName = input.founderName === undefined
    ? undefined
    : safeTaskText(input.founderName, PUBLIC_TASK_LIMITS.personName);
  const queries = founderName === undefined
    ? [
        `site:linkedin.com/in ${companyName} founder`,
        `${companyName} founder co-founder CEO`
      ]
    : [
        `site:linkedin.com/in ${founderName} ${companyName}`,
        `${founderName} ${companyName} founder LinkedIn profile`
      ];
  return queries.map((query) => query.slice(0, PUBLIC_TASK_LIMITS.query));
}

function createPublicTask(input: {
  item: FounderResearchRunItem;
  company: Company;
  reason: FounderPublicSearchTask["reason"];
  founder?: OfficialFounder;
}): FounderPublicSearchTask {
  const companyName = safeTaskText(
    input.company.name,
    PUBLIC_TASK_LIMITS.companyName
  );
  const knownFounderName = input.founder === undefined
    ? undefined
    : safeTaskText(
        input.founder.person.name,
        PUBLIC_TASK_LIMITS.personName
      );
  const knownFounderRole = input.founder === undefined
    ? undefined
    : safeTaskText(
        input.founder.normalizedRole,
        PUBLIC_TASK_LIMITS.role
      );
  const officialWebsiteUrl = safeWebsiteUrl(input.company.websiteUrl);
  return Object.freeze({
    runItemId: input.item.id,
    companyId: input.company.id,
    companyName,
    ...(officialWebsiteUrl === undefined ? {} : { officialWebsiteUrl }),
    ...(input.founder === undefined
      ? {}
      : {
          knownPersonId: input.founder.runPersonId,
          knownFounderName: knownFounderName!,
          knownFounderRole: knownFounderRole!
        }),
    suggestedQueries: publicSearchQueries({
      companyName,
      ...(knownFounderName === undefined ? {} : { founderName: knownFounderName })
    }),
    reason: input.reason
  });
}

function safeFailure(error: unknown): {
  code: string;
  summary: string;
  detail: Record<string, unknown>;
} {
  if (error instanceof DiscoveryDeadlineError) {
    return {
      code: "DISCOVERY_BUDGET_EXHAUSTED",
      summary: "Official founder discovery exceeded its bounded time budget",
      detail: { stage: "official_discovery", retryable: true }
    };
  }
  return {
    code: "OFFICIAL_SOURCE_UNAVAILABLE",
    summary: "Official founder sources could not be processed safely",
    detail: { stage: "official_discovery", retryable: true }
  };
}

export function createFounderResearchRunService(
  database: CareerDatabase,
  dependencies: FounderResearchRunDependencies
): FounderResearchRunService {
  if (!UUID_PATTERN.test(dependencies.subject)) {
    throw new DomainError(
      "AUTH_REQUIRED",
      "Authenticated request identity is required"
    );
  }
  const subject = dependencies.subject.toLowerCase();
  const now = dependencies.now ?? (() => new Date());

  async function getRun(runId: string): Promise<FounderResearchRun> {
    if (!UUID_PATTERN.test(runId)) {
      throw notFound();
    }
    try {
      const run = await database.founderResearchRuns.getOwned(runId, subject);
      if (run === undefined) {
        throw notFound();
      }
      return run;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "DATA_INTEGRITY",
        "Founder research run could not be read",
        { entity: "founder_research_run" }
      );
    }
  }

  async function saveOfficialFounders(
    item: FounderResearchRunItem,
    company: Company,
    people: readonly (PersonWithEvidence | StoredPersonWithEvidence)[],
    checkedAt: Date
  ): Promise<OfficialFounder[]> {
    const founders: OfficialFounder[] = [];
    for (const person of people) {
      const normalizedRole = founderRole(person);
      if (normalizedRole === undefined) {
        continue;
      }
      const profileValidation = person.publicProfileUrl === null
        || person.publicProfileUrl === undefined
        ? undefined
        : validateNonFetchingLinkedInProfileUrl(person.publicProfileUrl);
      const validProfile = profileValidation?.ok === true
        ? profileValidation.value
        : undefined;
      const storedPerson = await database.people.upsert({
        companyId: company.id,
        name: safeTaskText(person.name, PUBLIC_TASK_LIMITS.personName),
        role: normalizedRole,
        checkedAt: person.checkedAt ?? person.evidence[0]?.checkedAt ?? trustedNow(now).toISOString(),
        ...(validProfile === undefined ? {} : { publicProfileUrl: validProfile })
      });
      const runPerson = await database.founderResearchPeople.saveOfficial({
        runItemId: item.id,
        ownerSubject: subject,
        personId: storedPerson.id,
        founderRoleMatch: normalizedRole,
        confidence: confidenceFor(person)
      });
      const officialEvidence = person.evidence.find((entry) => (
        sameOfficialOrigin(entry.sourceUrl, company.websiteUrl)
        && isFreshTimestamp(entry.checkedAt, checkedAt)
      ));
      let verifiedProfile = false;
      if (validProfile !== undefined && officialEvidence !== undefined) {
        await database.founderProfileCandidates.recordOfficial({
          runPersonId: runPerson.id,
          ownerSubject: subject,
          profileUrl: validProfile,
          sourceKind: "OFFICIAL_COMPANY",
          evidenceUrl: officialEvidence.sourceUrl,
          evidenceTitle: officialEvidence.title || "Official company page",
          evidenceSnippet: `${safeTaskText(person.name, 200)} — ${normalizedRole}`,
          evidenceMetadataJson: {
            source: "official_people_discovery",
            linkedInFetched: false
          },
          checkedAt: officialEvidence.checkedAt,
          confidence: confidenceFor(person)
        });
        verifiedProfile = true;
      }
      founders.push({
        person,
        normalizedRole,
        storedPersonId: storedPerson.id,
        runPersonId: runPerson.id,
        ...(officialEvidence === undefined ? {} : { officialEvidence }),
        verifiedProfile
      });
    }
    return founders;
  }

  async function processItem(
    item: FounderResearchRunItem
  ): Promise<{
    item: FounderResearchProcessedItem;
    publicSearchTasks: FounderPublicSearchTask[];
  }> {
    try {
      const company = await database.companies.get(item.companyId);
      if (company === undefined) {
        throw new DomainError(
          "DATA_INTEGRITY",
          "Founder research company was not found",
          { entity: "company" }
        );
      }
      const requestNow = trustedNow(now);
      const reusable = await currentFreshOfficialFounders(
        database,
        company,
        requestNow
      );
      const result = reusable === undefined
        ? await dependencies.peopleDiscovery.discoverPublicPeople(company.id)
        : undefined;
      const people = reusable ?? result!.people;
      const founders = await saveOfficialFounders(
        item,
        company,
        people,
        requestNow
      );
      const duplicateNames = new Set<string>();
      const seenNames = new Set<string>();
      for (const founder of founders) {
        const name = normalizedPersonName(founder.person.name);
        if (seenNames.has(name)) {
          duplicateNames.add(name);
        }
        seenNames.add(name);
      }

      let state: "COMPLETE" | "PARTIAL" | "AMBIGUOUS" | "NEEDS_PUBLIC_SEARCH";
      let tasks: FounderPublicSearchTask[];
      if (duplicateNames.size > 0) {
        state = "AMBIGUOUS";
        tasks = [createPublicTask({
          item,
          company,
          reason: "AMBIGUOUS"
        })];
      } else if (founders.length === 0) {
        state = "NEEDS_PUBLIC_SEARCH";
        tasks = [createPublicTask({
          item,
          company,
          reason: "FOUNDER_NOT_FOUND"
        })];
      } else {
        const missingProfiles = founders.filter(({ verifiedProfile }) => !verifiedProfile);
        if (missingProfiles.length > 0) {
          state = "NEEDS_PUBLIC_SEARCH";
          tasks = missingProfiles.map((founder) => createPublicTask({
            item,
            company,
            founder,
            reason: "PROFILE_URL_MISSING"
          }));
        } else if ((result?.warnings.length ?? 0) > 0) {
          state = "PARTIAL";
          tasks = [];
        } else {
          state = "COMPLETE";
          tasks = [];
        }
      }

      const completed = await database.founderResearchRuns.completeItem({
        itemId: item.id,
        ownerSubject: subject,
        leaseAttempt: item.attemptCount,
        state,
        checkedAt: requestNow.toISOString()
      });
      if (completed === undefined) {
        return {
          item: {
            runItemId: item.id,
            companyId: company.id,
            leaseAttempt: item.attemptCount,
            state: "STALE_ATTEMPT",
            founderCount: 0,
            verifiedProfileCount: 0
          },
          publicSearchTasks: []
        };
      }
      return {
        item: {
          runItemId: item.id,
          companyId: company.id,
          leaseAttempt: item.attemptCount,
          state,
          founderCount: founders.length,
          verifiedProfileCount: founders.filter(({ verifiedProfile }) => verifiedProfile).length
        },
        publicSearchTasks: tasks
      };
    } catch (error) {
      const failure = safeFailure(error);
      const checkedAt = trustedNow(now).toISOString();
      const failed = await database.founderResearchRuns.failItem({
        itemId: item.id,
        ownerSubject: subject,
        leaseAttempt: item.attemptCount,
        checkedAt,
        errorCode: failure.code,
        errorSummary: failure.summary,
        errorDetailJson: failure.detail
      });
      return {
        item: {
          runItemId: item.id,
          companyId: item.companyId,
          leaseAttempt: item.attemptCount,
          state: failed === undefined ? "STALE_ATTEMPT" : "FAILED",
          founderCount: 0,
          verifiedProfileCount: 0,
          ...(failed === undefined
            ? {}
            : {
                errorCode: failure.code,
                errorSummary: failure.summary
              })
        },
        publicSearchTasks: []
      };
    }
  }

  async function processWithWorkerPool(
    items: readonly FounderResearchRunItem[]
  ): Promise<{
    items: FounderResearchProcessedItem[];
    publicSearchTasks: FounderPublicSearchTask[];
  }> {
    const results = new Array<Awaited<ReturnType<typeof processItem>>>(items.length);
    let nextIndex = 0;
    let active = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        active += 1;
        dependencies.concurrencyProbe?.(active);
        try {
          results[index] = await processItem(items[index]!);
        } finally {
          active -= 1;
          dependencies.concurrencyProbe?.(active);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_DISCOVERY_CONCURRENCY, items.length) },
        async () => await worker()
      )
    );
    return {
      items: results.map((result) => result.item),
      publicSearchTasks: results.flatMap((result) => result.publicSearchTasks)
    };
  }

  return Object.freeze({
    async startRun(
      queryInput: CompanySearchQuery,
      limitInput: number
    ): Promise<FounderResearchStartResult> {
      const query = validateQuery(queryInput);
      const limit = validateIntegerRange("limit", limitInput, 1, 50);
      let results: CompanyResult[];
      try {
        results = await dependencies.ycProvider.searchYcCompanies(query);
      } catch {
        throw new DomainError(
          "DATA_INTEGRITY",
          "YC company results could not be loaded safely",
          { entity: "yc_company_results" }
        );
      }
      if (!Array.isArray(results)) {
        throw new DomainError(
          "DATA_INTEGRITY",
          "YC company results are invalid",
          { entity: "yc_company_results" }
        );
      }
      const selected = selectCompanies(results, limit);
      try {
        const created = await database.founderResearchRuns.create({
          ownerSubject: subject,
          queryJson: query,
          requestedLimit: limit,
          companyIds: selected.map(({ id }) => id)
        });
        return {
          run: created.run,
          selectedCompanyIds: selected.map(({ id }) => id)
        };
      } catch {
        throw new DomainError(
          "DATA_INTEGRITY",
          "Founder research run could not be created",
          { entity: "founder_research_run" }
        );
      }
    },

    async processRun(
      runId: string,
      maxCompaniesInput: number
    ): Promise<FounderResearchProcessResult> {
      const maxCompanies = validateIntegerRange(
        "maxCompanies",
        maxCompaniesInput,
        1,
        MAX_COMPANIES_PER_CALL
      );
      const existing = await getRun(runId);
      const leasedAt = trustedNow(now);
      const leasedAtIso = leasedAt.toISOString();
      const leaseExpiresAt = new Date(
        leasedAt.getTime() + LEASE_DURATION_MS
      ).toISOString();
      try {
        await database.founderResearchRuns.releaseExpiredLeases({
          runId: existing.id,
          ownerSubject: subject,
          now: leasedAtIso
        });
        const leased = await database.founderResearchRuns.leaseNextItems({
          runId: existing.id,
          ownerSubject: subject,
          maxItems: maxCompanies,
          leasedAt: leasedAtIso,
          leaseExpiresAt
        });
        const processed = await processWithWorkerPool(leased);
        const run = await database.founderResearchRuns.recomputeCounters(
          existing.id,
          subject
        );
        if (run === undefined) {
          throw notFound();
        }
        return {
          run,
          leasedCount: leased.length,
          items: processed.items,
          publicSearchTasks: processed.publicSearchTasks,
          shouldContinue: run.selectedCount > (
            run.processedCount
            + (run.state === "NEEDS_PUBLIC_SEARCH"
              ? run.selectedCount - run.processedCount
              : 0)
          )
        };
      } catch (error) {
        if (error instanceof DomainError) {
          throw error;
        }
        throw new DomainError(
          "DATA_INTEGRITY",
          "Founder research run could not be processed",
          { entity: "founder_research_run" }
        );
      }
    },

    getRun
  });
}
