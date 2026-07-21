const GENERIC_ERROR = "Unable to complete this action.";
const EXPIRED_ERROR = "Exact preview expired. Create a new exact preview before publishing.";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const LINKEDIN_POST_URN_PATTERN = /^urn:li:(?:share|ugcPost):[0-9]+$/;
const SIGNED_MEDIA_PATH_PREFIX = "/storage/v1/object/sign/linkedin-draft-media/";
const CANONICAL_METADATA_KEYS = ["status", "call_tool_result", "mcp_tool_result"] as const;
const MAX_MEDIA = 4;
const DEFAULT_METADATA_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_SNAPSHOTS = 64;

export type ReviewCardVisibility = "PUBLIC" | "CONNECTIONS";

export type ReviewCardGlobals = Readonly<{
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
}>;

export type ReviewCardGlobalSource = Readonly<{
  snapshot(): ReviewCardGlobals;
  subscribe(listener: () => void): () => void;
}>;

export type ReviewCardMedia = Readonly<{
  position: number;
  mediaId: string;
  altText: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif";
  url: string | null;
}>;

export type ReviewCardView = Readonly<{
  postId: string;
  versionId: string;
  text: string;
  visibility: ReviewCardVisibility;
  version: number;
  checksum: string;
  media: readonly ReviewCardMedia[];
  previewExpiresAt: string | null;
}>;

export type PublishConfirmation = Readonly<{
  version: number;
  mediaCount: number;
  visibility: ReviewCardVisibility;
}>;

export type PublishTerminalView = Readonly<{
  kind: "published" | "definite_failure" | "ambiguous";
  message: string;
  postUrn?: string;
}>;

export type ReviewCardUi = Readonly<{
  render(view: ReviewCardView): void;
  showError(message: string): void;
  setBusy(busy: boolean): void;
  setPublishingEnabled(enabled: boolean): void;
  showTerminal(result: PublishTerminalView): void;
  confirm(details: PublishConfirmation): boolean | Promise<boolean>;
}>;

export type ReviewCardController = Readonly<{
  start(): Promise<void>;
  createPreview(): Promise<void>;
  publish(): Promise<void>;
}>;

export type ReviewCardControllerDependencies = Readonly<{
  storageOrigin: string;
  globals: ReviewCardGlobalSource;
  metadataTimeoutMs?: number;
  now?: () => Date;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  ui: ReviewCardUi;
}>;

type SafeMedia = Omit<ReviewCardMedia, "url">;

type SafePost = Readonly<{
  postId: string;
  versionId: string;
  text: string;
  visibility: ReviewCardVisibility;
  version: number;
  checksum: string;
  media: readonly SafeMedia[];
  expiresAt: string | null;
}>;

type PublishResult =
  | Readonly<{ state: "published"; postUrn: string }>
  | Readonly<{ state: "media_upload_failed" | "media_upload_unknown" | "publish_failed" | "publish_unknown" }>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function own(value: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((item, index) => item === sortedExpected[index]);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]));
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (leftRecord === undefined || rightRecord === undefined) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonEqual(leftRecord[key], rightRecord[key]));
}

function canonicalHttpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== value) {
    throw new Error("Storage origin is invalid");
  }
  return parsed.origin;
}

function visibility(value: unknown): ReviewCardVisibility | undefined {
  return value === "PUBLIC" || value === "CONNECTIONS" ? value : undefined;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function safeMedia(value: unknown, position: number): SafeMedia | undefined {
  const item = record(value);
  if (item === undefined
    || item.position !== position
    || typeof item.mediaId !== "string"
    || !UUID_PATTERN.test(item.mediaId)
    || typeof item.altText !== "string"
    || [...item.altText].length < 1
    || [...item.altText].length > 120
    || /[\r\n\u2028\u2029]/u.test(item.altText)
    || (item.mimeType !== "image/jpeg" && item.mimeType !== "image/png" && item.mimeType !== "image/gif")) {
    return undefined;
  }
  return {
    position,
    mediaId: item.mediaId,
    altText: item.altText,
    mimeType: item.mimeType
  };
}

function mediaList(value: unknown): readonly SafeMedia[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MEDIA) return undefined;
  const parsed: SafeMedia[] = [];
  const mediaIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = safeMedia(value[index], index);
    if (item === undefined || mediaIds.has(item.mediaId.toLowerCase())) return undefined;
    mediaIds.add(item.mediaId.toLowerCase());
    parsed.push(item);
  }
  return parsed;
}

function safePost(value: unknown, isPreview: boolean): SafePost | undefined {
  const post = record(value);
  const postId = isPreview ? post?.postId : post?.id;
  const expiresAt = isPreview ? canonicalTimestamp(post?.expiresAt) : null;
  const parsedVisibility = visibility(post?.visibility);
  const parsedMedia = mediaList(post?.media);
  if (post === undefined
    || typeof postId !== "string"
    || !UUID_PATTERN.test(postId)
    || typeof post.versionId !== "string"
    || !UUID_PATTERN.test(post.versionId)
    || typeof post.text !== "string"
    || [...post.text].length > 3_000
    || parsedVisibility === undefined
    || !Number.isSafeInteger(post.version)
    || (post.version as number) < 1
    || typeof post.checksum !== "string"
    || !CHECKSUM_PATTERN.test(post.checksum)
    || parsedMedia === undefined
    || (isPreview && expiresAt === undefined)) {
    return undefined;
  }
  return {
    postId,
    versionId: post.versionId,
    text: post.text,
    visibility: parsedVisibility,
    version: post.version as number,
    checksum: post.checksum,
    media: parsedMedia,
    expiresAt: expiresAt ?? null
  };
}

function nestedData(value: unknown): Record<string, unknown> | undefined {
  return record(record(value)?.data);
}

function initialPost(value: unknown): SafePost | undefined {
  return safePost(nestedData(value)?.post, false);
}

function previewPost(value: unknown): SafePost | undefined {
  return safePost(nestedData(value)?.preview, true);
}

function safeSignedUrl(value: unknown, storageOrigin: string): string | undefined {
  if (typeof value !== "string" || value.length > 4_096) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== storageOrigin
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.hash !== ""
      || !parsed.pathname.startsWith(SIGNED_MEDIA_PATH_PREFIX)
      || parsed.pathname.length <= SIGNED_MEDIA_PATH_PREFIX.length) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function canonicalPrivateMetadata(
  value: unknown,
  expectedStructuredContent: unknown
): Record<string, unknown> | undefined {
  const metadata = record(value);
  if (metadata === undefined) return undefined;
  const hasCanonicalKey = CANONICAL_METADATA_KEYS.some((key) => own(metadata, key));
  if (!hasCanonicalKey || !CANONICAL_METADATA_KEYS.every((key) => own(metadata, key))) {
    return undefined;
  }
  const mcpResult = record(metadata.mcp_tool_result);
  const hidden = record(mcpResult?._meta);
  if (mcpResult === undefined
    || hidden === undefined
    || (own(mcpResult, "isError") && mcpResult.isError !== false)
    || !own(mcpResult, "structuredContent")
    || !jsonEqual(mcpResult.structuredContent, expectedStructuredContent)) {
    return undefined;
  }
  return hidden;
}

function initialPrivateMetadata(
  value: unknown,
  expectedStructuredContent: unknown
): Record<string, unknown> | undefined {
  const metadata = record(value);
  if (metadata === undefined) return undefined;
  const hasCanonicalKey = CANONICAL_METADATA_KEYS.some((key) => own(metadata, key));
  if (hasCanonicalKey) return canonicalPrivateMetadata(metadata, expectedStructuredContent);
  if (own(metadata, "_meta")) return record(metadata._meta);
  return metadata;
}

function initialUrls(
  metadataValue: unknown,
  structuredContent: unknown,
  count: number,
  storageOrigin: string
): readonly string[] | undefined {
  const urls = initialPrivateMetadata(metadataValue, structuredContent)?.mediaUrls;
  if (!Array.isArray(urls) || urls.length !== count) return undefined;
  const parsed = urls.map((url) => safeSignedUrl(url, storageOrigin));
  return parsed.every((url): url is string => url !== undefined) ? parsed : undefined;
}

function previewMetadata(
  metadataValue: unknown,
  structuredContent: unknown,
  count: number,
  storageOrigin: string
): Readonly<{ capability: string; urls: readonly string[] }> | undefined {
  const metadata = canonicalPrivateMetadata(metadataValue, structuredContent);
  if (metadata === undefined
    || typeof metadata.approvalCapability !== "string"
    || !CAPABILITY_PATTERN.test(metadata.approvalCapability)
    || !Array.isArray(metadata.signedMediaUrls)
    || metadata.signedMediaUrls.length !== count) {
    return undefined;
  }
  const urls: string[] = [];
  for (let position = 0; position < metadata.signedMediaUrls.length; position += 1) {
    const item = record(metadata.signedMediaUrls[position]);
    const url = safeSignedUrl(item?.url, storageOrigin);
    if (item?.position !== position || url === undefined) return undefined;
    urls.push(url);
  }
  return { capability: metadata.approvalCapability, urls };
}

function normalizedCallStructuredContent(value: unknown): unknown {
  const result = record(value);
  return result !== undefined && own(result, "structuredContent")
    ? result.structuredContent
    : value;
}

function callWasError(value: unknown): boolean {
  const result = record(value);
  return result !== undefined && own(result, "isError") && result.isError !== false;
}

function sameSelectedVersion(preview: SafePost, selected: SafePost): boolean {
  return preview.postId === selected.postId
    && preview.versionId === selected.versionId
    && preview.version === selected.version
    && preview.checksum === selected.checksum
    && preview.visibility === selected.visibility
    && preview.text === selected.text
    && preview.media.length === selected.media.length
    && preview.media.every((item, index) => {
      const expected = selected.media[index];
      return expected !== undefined
        && item.position === expected.position
        && item.mediaId === expected.mediaId
        && item.altText === expected.altText
        && item.mimeType === expected.mimeType;
    });
}

function view(post: SafePost, urls: readonly string[]): ReviewCardView {
  return {
    postId: post.postId,
    versionId: post.versionId,
    text: post.text,
    visibility: post.visibility,
    version: post.version,
    checksum: post.checksum,
    media: post.media.map((item) => ({ ...item, url: urls[item.position] ?? null })),
    previewExpiresAt: post.expiresAt
  };
}

function publishResult(value: unknown): PublishResult | undefined {
  const envelope = record(value);
  if (envelope === undefined
    || (own(envelope, "isError") && envelope.isError !== false)
    || !own(envelope, "structuredContent")) {
    return undefined;
  }
  const structured = record(envelope.structuredContent);
  const data = record(structured?.data);
  const result = record(data?.result);
  if (structured === undefined
    || data === undefined
    || result === undefined
    || !exactKeys(structured, ["data"])
    || !exactKeys(data, ["result"])) {
    return undefined;
  }
  if (result.state === "published") {
    return exactKeys(result, ["state", "postUrn"])
      && typeof result.postUrn === "string"
      && LINKEDIN_POST_URN_PATTERN.test(result.postUrn)
      ? { state: "published", postUrn: result.postUrn }
      : undefined;
  }
  if (result.state === "media_upload_failed"
    || result.state === "media_upload_unknown"
    || result.state === "publish_failed"
    || result.state === "publish_unknown") {
    return exactKeys(result, ["state"]) ? { state: result.state } : undefined;
  }
  return undefined;
}

function terminalView(result: PublishResult | undefined): PublishTerminalView {
  if (result?.state === "published") {
    return {
      kind: "published",
      message: "Published to LinkedIn. This exact approval has been consumed.",
      postUrn: result.postUrn
    };
  }
  if (result?.state === "media_upload_failed" || result?.state === "publish_failed") {
    return {
      kind: "definite_failure",
      message: "LinkedIn publishing did not complete. This approval has been consumed; reload before trying again."
    };
  }
  return {
    kind: "ambiguous",
    message: "Publishing outcome is uncertain. Check LinkedIn manually before doing anything else. This approval has been consumed."
  };
}

type GlobalsCapture = Readonly<{
  checkpoint(): void;
  waitFor<T>(select: (globals: ReviewCardGlobals) => T | undefined): Promise<T>;
  cancel(): void;
}>;

function beginGlobalsCapture(source: ReviewCardGlobalSource, timeoutMs: number): GlobalsCapture {
  const snapshots: ReviewCardGlobals[] = [];
  let selector: ((globals: ReviewCardGlobals) => unknown | undefined) | undefined;
  let resolveMatch: ((value: unknown) => void) | undefined;
  let rejectMatch: ((error: Error) => void) | undefined;
  let settled = false;
  let timedOut = false;
  let unsubscribe: () => void = () => undefined;

  function cleanup(): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
  }

  function inspect(): void {
    if (settled) return;
    let snapshot: ReviewCardGlobals;
    try {
      snapshot = source.snapshot();
    } catch {
      return;
    }
    snapshots.push(snapshot);
    if (snapshots.length > MAX_CAPTURED_SNAPSHOTS) snapshots.shift();
    drain();
  }

  function drain(): void {
    if (settled || selector === undefined || resolveMatch === undefined) return;
    for (const snapshot of snapshots) {
      let matched: unknown;
      try {
        matched = selector(snapshot);
      } catch {
        matched = undefined;
      }
      if (matched !== undefined) {
        const resolve = resolveMatch;
        cleanup();
        resolve(matched);
        return;
      }
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    const reject = rejectMatch;
    cleanup();
    reject?.(new Error("metadata timeout"));
  }, timeoutMs);
  try {
    unsubscribe = source.subscribe(inspect);
    inspect();
  } catch (error) {
    clearTimeout(timer);
    settled = true;
    throw error;
  }

  return {
    checkpoint(): void {
      if (!settled && selector === undefined) snapshots.splice(0, snapshots.length);
    },
    waitFor<T>(select: (globals: ReviewCardGlobals) => T | undefined): Promise<T> {
      if (selector !== undefined) return Promise.reject(new Error("metadata waiter already used"));
      selector = select;
      return new Promise<T>((resolve, reject) => {
        resolveMatch = resolve as (value: unknown) => void;
        rejectMatch = reject;
        if (timedOut || settled) {
          reject(new Error("metadata timeout"));
          return;
        }
        drain();
      });
    },
    cancel: cleanup
  };
}

export function createReviewCardController(
  dependencies: ReviewCardControllerDependencies
): ReviewCardController {
  const storageOrigin = canonicalHttpsOrigin(dependencies.storageOrigin);
  const timeoutMs = Number.isSafeInteger(dependencies.metadataTimeoutMs)
    && (dependencies.metadataTimeoutMs as number) > 0
    && (dependencies.metadataTimeoutMs as number) <= 10_000
    ? dependencies.metadataTimeoutMs as number
    : DEFAULT_METADATA_TIMEOUT_MS;
  let currentPost: SafePost | undefined;
  let approvalCapability: string | undefined;
  let busy = false;
  let terminal = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const now = dependencies.now ?? (() => new Date());

  function previewExpired(post: SafePost): boolean {
    if (post.expiresAt === null) return true;
    let current: Date;
    try {
      current = now();
    } catch {
      return true;
    }
    return !(current instanceof Date)
      || !Number.isFinite(current.getTime())
      || Date.parse(post.expiresAt) <= current.getTime();
  }

  function clearExpiryTimer(): void {
    if (expiryTimer === undefined) return;
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }

  function disablePublishing(): void {
    clearExpiryTimer();
    approvalCapability = undefined;
    dependencies.ui.setPublishingEnabled(false);
  }

  function scheduleExpiry(post: SafePost): boolean {
    clearExpiryTimer();
    if (post.expiresAt === null) return false;
    let current: Date;
    try {
      current = now();
    } catch {
      return false;
    }
    const currentTime = current instanceof Date ? current.getTime() : Number.NaN;
    const expiresAt = Date.parse(post.expiresAt);
    if (!Number.isFinite(currentTime) || !Number.isFinite(expiresAt) || expiresAt <= currentTime) {
      return false;
    }
    const delay = Math.min(expiresAt - currentTime, 2_147_483_647);
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (
        terminal
        || approvalCapability === undefined
        || currentPost?.versionId !== post.versionId
        || currentPost.expiresAt !== post.expiresAt
      ) return;
      if (!previewExpired(post)) {
        scheduleExpiry(post);
        return;
      }
      disablePublishing();
      dependencies.ui.showError(EXPIRED_ERROR);
    }, delay);
    (expiryTimer as unknown as { unref?: () => void }).unref?.();
    return true;
  }

  function genericError(): void {
    dependencies.ui.showError(GENERIC_ERROR);
  }

  return {
    async start() {
      terminal = false;
      disablePublishing();
      let capture: GlobalsCapture | undefined;
      try {
        capture = beginGlobalsCapture(dependencies.globals, timeoutMs);
        const loaded = await capture.waitFor((globals) => {
          const post = initialPost(globals.toolOutput);
          const urls = post === undefined
            ? undefined
            : initialUrls(
              globals.toolResponseMetadata,
              globals.toolOutput,
              post.media.length,
              storageOrigin
            );
          return post === undefined || urls === undefined ? undefined : { post, urls };
        });
        currentPost = loaded.post;
        dependencies.ui.render(view(loaded.post, loaded.urls));
      } catch {
        currentPost = undefined;
        disablePublishing();
        genericError();
      } finally {
        capture?.cancel();
      }
    },

    async createPreview() {
      if (busy || terminal) return;
      const selectedPost = currentPost;
      if (selectedPost === undefined) {
        genericError();
        return;
      }
      busy = true;
      dependencies.ui.setBusy(true);
      disablePublishing();
      let capture: GlobalsCapture | undefined;
      try {
        capture = beginGlobalsCapture(dependencies.globals, timeoutMs);
        capture.checkpoint();
        const callResult = await dependencies.callTool("create_exact_linkedin_preview", {
          postId: selectedPost.postId,
          version: selectedPost.version
        });
        if (callWasError(callResult)) throw new Error("preview failed");
        const structuredContent = normalizedCallStructuredContent(callResult);
        const preview = previewPost(structuredContent);
        if (preview === undefined || !sameSelectedVersion(preview, selectedPost)) {
          throw new Error("invalid preview");
        }
        const metadata = await capture.waitFor((globals) => previewMetadata(
          globals.toolResponseMetadata,
          structuredContent,
          preview.media.length,
          storageOrigin
        ));
        currentPost = preview;
        dependencies.ui.render(view(preview, metadata.urls));
        approvalCapability = metadata.capability;
        if (!scheduleExpiry(preview)) {
          disablePublishing();
          dependencies.ui.showError(EXPIRED_ERROR);
        } else {
          dependencies.ui.setPublishingEnabled(true);
        }
      } catch {
        disablePublishing();
        genericError();
      } finally {
        capture?.cancel();
        busy = false;
        dependencies.ui.setBusy(false);
      }
    },

    async publish() {
      if (busy || terminal) return;
      const capability = approvalCapability;
      const selectedPost = currentPost;
      if (capability === undefined || selectedPost === undefined || selectedPost.expiresAt === null) {
        genericError();
        return;
      }
      if (previewExpired(selectedPost)) {
        disablePublishing();
        dependencies.ui.showError(EXPIRED_ERROR);
        return;
      }
      busy = true;
      dependencies.ui.setBusy(true);
      let dispatched = false;
      try {
        const confirmed = await dependencies.ui.confirm({
          version: selectedPost.version,
          mediaCount: selectedPost.media.length,
          visibility: selectedPost.visibility
        });
        if (!confirmed) return;
        if (previewExpired(selectedPost)) {
          disablePublishing();
          dependencies.ui.showError(EXPIRED_ERROR);
          return;
        }
        disablePublishing();
        terminal = true;
        dispatched = true;
        const result = await dependencies.callTool("publish_exact_linkedin_post", {
          approvalCapability: capability
        });
        dependencies.ui.showTerminal(terminalView(publishResult(result)));
      } catch {
        if (dispatched) dependencies.ui.showTerminal(terminalView(undefined));
        else genericError();
      } finally {
        busy = false;
        dependencies.ui.setBusy(false);
      }
    }
  };
}
