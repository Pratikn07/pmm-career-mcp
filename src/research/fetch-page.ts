import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as wait } from "node:timers/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { load } from "cheerio";
import { assertFetchableUrl } from "./url-policy.js";

export type FetchPageOptions = {
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryAfterMs?: number;
  maxConcurrencyPerHost?: number;
};

export type FetchedPage = {
  url: string;
  title: string;
  text: string;
  checkedAt: string;
  contentType: string;
  untrusted: true;
};

const ALLOWED_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const DEFAULT_MAX_CONCURRENCY_PER_HOST = 2;
const URL_POLICY_PREFLIGHT_ADDRESS = "2606:4700:4700::1111";

type HostWaiter = {
  signal: AbortSignal;
  abort: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
};

type HostGate = {
  active: number;
  limit: number;
  waiters: HostWaiter[];
};

const hostGates = new Map<string, HostGate>();

function grantHostWaiters(hostname: string, gate: HostGate): void {
  while (gate.waiters.length > 0) {
    const waiter = gate.waiters[0]!;
    if (gate.active >= gate.limit) {
      break;
    }
    gate.waiters.shift();
    waiter.signal.removeEventListener("abort", waiter.abort);
    gate.active += 1;
    waiter.resolve(createHostRelease(hostname, gate));
  }
  if (gate.active === 0 && gate.waiters.length === 0 && hostGates.get(hostname) === gate) {
    hostGates.delete(hostname);
  }
}

function createHostRelease(hostname: string, gate: HostGate): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    gate.active -= 1;
    grantHostWaiters(hostname, gate);
  };
}

async function acquireHostPermit(
  hostname: string,
  limit: number,
  signal: AbortSignal
): Promise<() => void> {
  if (signal.aborted) {
    throw signal.reason;
  }
  let gate = hostGates.get(hostname);
  if (gate === undefined) {
    gate = { active: 0, limit, waiters: [] };
    hostGates.set(hostname, gate);
  } else if (gate.limit !== limit) {
    throw new Error(
      `Conflicting per-host concurrency limit for ${hostname}: active ${gate.limit}, requested ${limit}`
    );
  }
  if (gate.active < gate.limit && gate.waiters.length === 0) {
    gate.active += 1;
    return createHostRelease(hostname, gate);
  }

  return await new Promise<() => void>((resolve, reject) => {
    const waiter: HostWaiter = {
      signal,
      abort: () => {
        const index = gate.waiters.indexOf(waiter);
        if (index !== -1) {
          gate.waiters.splice(index, 1);
        }
        reject(signal.reason);
        grantHostWaiters(hostname, gate);
      },
      resolve,
      reject
    };
    gate.waiters.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
  });
}

class ResponseSizeError extends Error {
  constructor(maxBytes: number) {
    super(`Public page response exceeds the ${maxBytes}-byte size limit`);
  }
}

class ByteLimitTransform extends Transform {
  readonly #maxBytes: number;
  #receivedBytes = 0;

  constructor(maxBytes: number) {
    super();
    this.#maxBytes = maxBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#receivedBytes += chunk.byteLength;
    if (this.#receivedBytes > this.#maxBytes) {
      callback(new ResponseSizeError(this.#maxBytes));
      return;
    }
    callback(null, chunk);
  }
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
}

function hostnameWithoutBrackets(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

async function resolveHopAddresses(
  url: URL,
  resolveAddresses: (hostname: string) => Promise<string[]>,
  signal: AbortSignal
): Promise<string[]> {
  const hostname = hostnameWithoutBrackets(url);
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  try {
    return await withAbort(resolveAddresses(hostname), signal);
  } catch {
    if (signal.aborted) {
      throw signal.reason;
    }
    throw new Error(`DNS resolution failed for ${hostname}`);
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason;
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function containsInstructionLikeText(value: string): boolean {
  const normalized = normalizedText(value);
  return [
    /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:instructions?|rules?|prompts?|messages?)\b/i,
    /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:above|previous|prior|everything|all)\b/i,
    /\b(?:return|reveal|expose|print|send)\b.{0,80}\b(?:private|personal|sensitive|system|developer|secret|credential|data)\b/i,
    /\b(?:system|developer|assistant)\s*:\s*/i,
    /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
    /\b(?:you are|act as)\s+(?:chatgpt|an?\s+(?:ai|language model))/i
  ].some((pattern) => pattern.test(normalized));
}

function sanitizedExtractedText(value: string): string {
  const retainedLines = value
    .split(/\r?\n/)
    .map(normalizedText)
    .filter((line) => line !== "" && !containsInstructionLikeText(line));
  const retainedText = retainedLines.join(" ");
  return containsInstructionLikeText(retainedText) ? "" : retainedText;
}

function hasHiddenStyleDeclaration(declarations: string): boolean {
  const withoutComments = declarations.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const declaration of withoutComments.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .replace(/\s*!important\s*$/i, "")
      .trim()
      .toLowerCase();
    if (property === "display" && value === "none") {
      return true;
    }
    if (property === "visibility" && (value === "hidden" || value === "collapse")) {
      return true;
    }
    if (
      property === "opacity"
      && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
      && Number(value) === 0
    ) {
      return true;
    }
  }
  return false;
}

function supportedHiddenStylesheetSelectors(css: string): string[] {
  const selectors: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  // Deliberately not a browser CSS engine: honor comma-separated single compound selectors made
  // from a tag, classes, IDs, and hidden/aria-hidden attributes when their rule explicitly hides.
  const supportedSelector = /^(?:[a-z][a-z0-9-]*|\*)?(?:(?:[.#][-_a-z0-9]+)|(?:\[(?:hidden|aria-hidden)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[-_a-z0-9]+))?\]))*$/i;
  for (const rule of rules) {
    const selectorList = rule[1] ?? "";
    const declarations = rule[2] ?? "";
    if (!hasHiddenStyleDeclaration(declarations)) {
      continue;
    }
    for (const selector of selectorList.split(",").map((value) => value.trim())) {
      if (selector !== "" && supportedSelector.test(selector)) {
        selectors.push(selector);
      }
    }
  }
  return selectors;
}

function extractHtml(html: string): { title: string; text: string } {
  const $ = load(html);
  const title = sanitizedExtractedText($("title").first().text());

  const stylesheetSelectors = $("style")
    .toArray()
    .flatMap((element) => supportedHiddenStylesheetSelectors($(element).text()));
  for (const selector of stylesheetSelectors) {
    $(selector).remove();
  }

  $(
    "script, style, noscript, form, template, iframe, object, embed, canvas, svg, link, meta, [hidden]"
  ).remove();
  $("[aria-hidden]").filter((_index, element) => {
    return ($(element).attr("aria-hidden") ?? "").trim().toLowerCase() === "true";
  }).remove();
  $("[style]").filter((_index, element) => {
    const style = $(element).attr("style") ?? "";
    return hasHiddenStyleDeclaration(style);
  }).remove();
  $("br").replaceWith("\n");
  const instructionBlocks = $(
    "p, li, blockquote, pre, td, th, div, section, article, header, footer, main, nav, aside"
  ).toArray().reverse();
  for (const element of instructionBlocks) {
    if (containsInstructionLikeText($(element).text())) {
      $(element).remove();
    }
  }
  $("body *").filter((_index, element) => {
    return $(element).children().length === 0 && containsInstructionLikeText($(element).text());
  }).remove();
  $("p, div, section, article, header, footer, main, nav, aside, h1, h2, h3, h4, h5, h6, li, tr")
    .append("\n");

  return { title, text: sanitizedExtractedText($("body").text()) };
}

function createPinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new Error("Resolved address is not a valid IP");
  }
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function createPinnedRequestOptions(address: string, signal: AbortSignal): http.RequestOptions {
  return {
    method: "GET",
    agent: false,
    signal,
    headers: {
      Accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
      "User-Agent": "pmm-career-mcp/1.0 public-research-fetcher"
    },
    lookup: createPinnedLookup(address)
  };
}

async function requestPage(
  url: URL,
  address: string,
  signal: AbortSignal
): Promise<http.IncomingMessage> {
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const request = transport.request(url, createPinnedRequestOptions(address, signal), resolve);
    request.once("error", reject);
    request.end();
  });
}

function contentDecoder(encoding: string): Transform | undefined {
  if (encoding === "" || encoding === "identity") {
    return undefined;
  }
  if (encoding === "gzip" || encoding === "x-gzip") {
    return createGunzip();
  }
  if (encoding === "deflate") {
    return createInflate();
  }
  if (encoding === "br") {
    return createBrotliDecompress();
  }
  throw new Error(`Unsupported public page content encoding: ${encoding}`);
}

function retryDelayMs(
  retryAfter: string | undefined,
  retryCount: number,
  maxRetryAfterMs: number
): number {
  if (retryAfter === undefined) {
    return Math.min(DEFAULT_RETRY_BACKOFF_MS * 2 ** retryCount, maxRetryAfterMs);
  }

  let delay: number;
  if (/^\d+$/.test(retryAfter.trim())) {
    delay = Number(retryAfter.trim()) * 1_000;
  } else {
    const retryAt = Date.parse(retryAfter);
    if (Number.isNaN(retryAt)) {
      throw new Error("Public page returned an invalid Retry-After header");
    }
    delay = Math.max(0, retryAt - Date.now());
  }
  if (!Number.isSafeInteger(delay) || delay > maxRetryAfterMs) {
    throw new Error(`Retry-After exceeds the ${maxRetryAfterMs} ms wait limit`);
  }
  return delay;
}

async function readResponse(
  response: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const declaredLength = response.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      response.destroy();
      throw new Error("Public page returned an invalid Content-Length header");
    }
    if (Number(declaredLength) > maxBytes) {
      response.destroy();
      throw new ResponseSizeError(maxBytes);
    }
  }

  const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
  let decoder: Transform | undefined;
  try {
    decoder = contentDecoder(encoding);
  } catch (error) {
    response.destroy();
    throw error;
  }

  const chunks: Buffer[] = [];
  const outputLimit = new ByteLimitTransform(maxBytes);
  outputLimit.on("data", (chunk: Buffer) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  if (decoder === undefined) {
    await pipeline(response, outputLimit, { signal });
  } else {
    await pipeline(response, new ByteLimitTransform(maxBytes), decoder, outputLimit, { signal });
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchPublicPage(
  rawUrl: string,
  options: FetchPageOptions = {}
): Promise<FetchedPage> {
  const url = new URL(rawUrl);
  const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const maxConcurrencyPerHost = options.maxConcurrencyPerHost ?? DEFAULT_MAX_CONCURRENCY_PER_HOST;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("maxRedirects must be a non-negative integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxRetryAfterMs) || maxRetryAfterMs < 0) {
    throw new Error("maxRetryAfterMs must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxConcurrencyPerHost) || maxConcurrencyPerHost <= 0) {
    throw new Error("maxConcurrencyPerHost must be a positive integer");
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = url;
  let redirectCount = 0;
  let retryCount = 0;
  try {
    while (true) {
      // Reuse the public policy to reject static URL hazards before DNS; this validated address is
      // a preflight sentinel only and is never used for transport.
      assertFetchableUrl(currentUrl, [URL_POLICY_PREFLIGHT_ADDRESS]);
      const hostname = hostnameWithoutBrackets(currentUrl).toLowerCase().replace(/\.+$/, "");
      const releaseHost = await acquireHostPermit(hostname, maxConcurrencyPerHost, signal);
      try {
        const addresses = await resolveHopAddresses(currentUrl, resolveAddresses, signal);
        assertFetchableUrl(currentUrl, addresses);
        const response = await requestPage(currentUrl, addresses[0]!, signal);
        const status = response.statusCode ?? 0;

        if (REDIRECT_STATUSES.has(status)) {
          const location = response.headers.location;
          response.destroy();
          if (location === undefined) {
            throw new Error(`Public page redirect HTTP ${status} is missing a Location header`);
          }
          if (redirectCount >= maxRedirects) {
            throw new Error(`Public page redirect limit of ${maxRedirects} exceeded`);
          }
          currentUrl = new URL(location, currentUrl);
          redirectCount += 1;
          continue;
        }

        if (status === 429) {
          const retryAfter = response.headers["retry-after"];
          response.destroy();
          if (retryCount >= maxRetries) {
            throw new Error(`Public page request failed with HTTP 429 after ${retryCount} retries`);
          }
          const delay = retryDelayMs(retryAfter, retryCount, maxRetryAfterMs);
          retryCount += 1;
          if (delay > 0) {
            await wait(delay, undefined, { signal });
          }
          continue;
        }

        if (status < 200 || status >= 300) {
          response.destroy();
          throw new Error(`Public page request failed with HTTP ${status}`);
        }
        const contentType = (response.headers["content-type"] ?? "")
          .split(";", 1)[0]!
          .trim()
          .toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
          response.destroy();
          throw new Error(`Unsupported public page content type: ${contentType || "missing"}`);
        }
        const body = await readResponse(response, maxBytes, signal);
        const extracted = contentType === "text/plain"
          ? { title: "", text: sanitizedExtractedText(body) }
          : extractHtml(body);

        return {
          url: currentUrl.href,
          title: extracted.title,
          text: extracted.text,
          checkedAt: new Date().toISOString(),
          contentType,
          untrusted: true
        };
      } finally {
        releaseHost();
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Public page request timed out after ${timeoutMs} ms`);
    }
    throw error;
  }
}
