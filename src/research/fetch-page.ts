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
  html: string;
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
const MAX_STYLESHEET_BYTES = 128 * 1024;
const MAX_STYLESHEET_RULES = 512;
const MAX_STYLESHEET_SELECTORS = 1_024;
const MAX_STYLESHEET_SELECTOR_LENGTH = 256;
const MAX_STYLESHEET_SELECTOR_PARTS = 8;
const MAX_STYLESHEET_CUSTOM_PROPERTIES = 64;
const MAX_STYLESHEET_MATCH_WORK = 50_000;
const MAX_INSTRUCTION_BLOCK_SCAN_WORK = 50_000;

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

const META_INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:instructions?|rules?|prompts?|messages?)\b/i,
  /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:above|previous|prior|everything|all)\b/i
];
const SENSITIVE_ACTION_PATTERN = /\b(?:return|reveal|expose|print|send)\b.{0,80}\b(?:private|personal|sensitive|system|developer|secret|credentials?|data)\b/i;

function hasMetaInstructionContext(value: string): boolean {
  const normalized = normalizedText(value);
  return META_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function containsInstructionLikeText(value: string): boolean {
  const normalized = normalizedText(value);
  return [
    ...META_INSTRUCTION_PATTERNS,
    /\b(?:reveal|expose|print|send)\b.{0,80}\b(?:private|personal|sensitive|system|developer|secret|credentials?|data)\b/i,
    /\b(?:system|developer|assistant)\s*:\s*/i,
    /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
    /\b(?:you are|act as)\s+(?:chatgpt|an?\s+(?:ai|language model))/i
  ].some((pattern) => pattern.test(normalized));
}

function sanitizedExtractedText(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map(normalizedText)
    .filter((line) => line !== "");
  const retainedLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^(?:ignore|disregard|forget|override)\b/i.test(line)) {
      let sequence = line;
      let sequenceEnd = index;
      while (sequenceEnd + 1 < lines.length && sequenceEnd - index < 2) {
        const nextLine = lines[sequenceEnd + 1]!;
        const currentLineEndsSentence = /[.!?]["')\]]*$/.test(lines[sequenceEnd]!);
        if (currentLineEndsSentence && !SENSITIVE_ACTION_PATTERN.test(nextLine)) {
          break;
        }
        sequence = `${sequence} ${nextLine}`;
        sequenceEnd += 1;
      }
      if (hasMetaInstructionContext(sequence)) {
        index = sequenceEnd;
        continue;
      }
    }
    if (!containsInstructionLikeText(line)) {
      retainedLines.push(line);
    }
  }
  return retainedLines.join(" ");
}

function cssDeclarations(declarations: string): Array<readonly [string, string]> {
  const withoutComments = declarations.replace(/\/\*[\s\S]*?\*\//g, "");
  const parsed: Array<readonly [string, string]> = [];
  for (const declaration of withoutComments.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .replace(/\s*!important\s*$/i, "")
      .trim();
    if (property !== "") {
      parsed.push([property, value]);
    }
  }
  return parsed;
}

function resolvedCssValue(value: string, variables: ReadonlyMap<string, string>): string {
  let resolved = value.trim().toLowerCase();
  for (let depth = 0; depth < 4; depth += 1) {
    const variable = resolved.match(/^var\(\s*(--[-_a-z0-9]+)\s*(?:,\s*([^)]*))?\)$/i);
    if (variable === null) {
      return resolved;
    }
    const replacement = variables.get(variable[1]!.toLowerCase()) ?? variable[2];
    if (replacement === undefined) {
      return "";
    }
    resolved = replacement.trim().toLowerCase();
  }
  return "";
}

function hasHiddenStyleDeclaration(
  declarations: string,
  variables: ReadonlyMap<string, string> = new Map()
): boolean {
  for (const [property, rawValue] of cssDeclarations(declarations)) {
    const value = resolvedCssValue(rawValue, variables);
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

type CssRule = {
  selectors: string[];
  declarations: string;
};

type CompoundSelector = {
  tag?: string;
  ids: string[];
  classes: string[];
  attributes: Array<{ name: string; value?: string }>;
};

type CompiledSelector = {
  parts: CompoundSelector[];
  combinators: Array<"child" | "descendant">;
};

function stylesheetLimitError(detail: string): Error {
  return new Error(`Public page stylesheet ${detail} limit exceeded`);
}

function parseStylesheetRules(stylesheets: string[]): CssRule[] {
  let totalBytes = 0;
  let totalRules = 0;
  let totalSelectors = 0;
  const parsedRules: CssRule[] = [];
  for (const stylesheet of stylesheets) {
    totalBytes += Buffer.byteLength(stylesheet, "utf8");
    if (totalBytes > MAX_STYLESHEET_BYTES) {
      throw stylesheetLimitError(`${MAX_STYLESHEET_BYTES}-byte`);
    }
    const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      totalRules += 1;
      if (totalRules > MAX_STYLESHEET_RULES) {
        throw stylesheetLimitError(`${MAX_STYLESHEET_RULES}-rule`);
      }
      const selectors = (rule[1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");
      totalSelectors += selectors.length;
      if (totalSelectors > MAX_STYLESHEET_SELECTORS) {
        throw stylesheetLimitError(`${MAX_STYLESHEET_SELECTORS}-selector`);
      }
      for (const selector of selectors) {
        if (selector.length > MAX_STYLESHEET_SELECTOR_LENGTH) {
          throw stylesheetLimitError(`${MAX_STYLESHEET_SELECTOR_LENGTH}-character selector`);
        }
      }
      parsedRules.push({ selectors, declarations: rule[2] ?? "" });
    }
  }
  return parsedRules;
}

function splitSelector(selector: string): {
  compounds: string[];
  combinators: Array<"child" | "descendant">;
} | undefined {
  const compounds: string[] = [];
  const combinators: Array<"child" | "descendant"> = [];
  let current = "";
  let bracketDepth = 0;
  let quote = "";
  let pendingDescendant = false;
  const pushCompound = () => {
    const compound = current.trim();
    if (compound !== "") {
      compounds.push(compound);
      if (compounds.length > MAX_STYLESHEET_SELECTOR_PARTS) {
        throw stylesheetLimitError(`${MAX_STYLESHEET_SELECTOR_PARTS}-part selector complexity`);
      }
      current = "";
    }
  };

  for (const character of selector) {
    if (quote !== "") {
      current += character;
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if ((character === "\"" || character === "'") && bracketDepth > 0) {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[") {
      bracketDepth += 1;
      current += character;
      continue;
    }
    if (character === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        return undefined;
      }
      current += character;
      continue;
    }
    if (bracketDepth === 0 && /\s/.test(character)) {
      if (current.trim() !== "") {
        pushCompound();
        pendingDescendant = true;
      }
      continue;
    }
    if (bracketDepth === 0 && character === ">") {
      pushCompound();
      if (compounds.length === 0 || combinators.length >= compounds.length) {
        return undefined;
      }
      combinators.push("child");
      pendingDescendant = false;
      continue;
    }
    if (pendingDescendant) {
      if (combinators.length < compounds.length) {
        combinators.push("descendant");
      }
      pendingDescendant = false;
    }
    current += character;
  }
  if (quote !== "" || bracketDepth !== 0) {
    return undefined;
  }
  pushCompound();
  if (compounds.length === 0 || combinators.length !== compounds.length - 1) {
    return undefined;
  }
  return { compounds, combinators };
}

function parseCompoundSelector(selector: string): CompoundSelector | undefined {
  let remaining = selector;
  let tag: string | undefined;
  const tagMatch = remaining.match(/^(?:[a-z][a-z0-9-]*|\*)/i);
  if (tagMatch !== null) {
    tag = tagMatch[0]!.toLowerCase();
    remaining = remaining.slice(tagMatch[0]!.length);
  }
  const ids: string[] = [];
  const classes: string[] = [];
  const attributes: Array<{ name: string; value?: string }> = [];
  while (remaining !== "") {
    const simple = remaining.match(/^([.#])([-_a-z0-9]+)/i);
    if (simple !== null) {
      (simple[1] === "." ? classes : ids).push(simple[2]!);
      remaining = remaining.slice(simple[0].length);
      continue;
    }
    const attribute = remaining.match(
      /^\[(hidden|aria-hidden)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([-_a-z0-9]+)))?\]/i
    );
    if (attribute === null) {
      return undefined;
    }
    const value = attribute[2] ?? attribute[3] ?? attribute[4];
    attributes.push({
      name: attribute[1]!.toLowerCase(),
      ...(value === undefined ? {} : { value })
    });
    remaining = remaining.slice(attribute[0].length);
  }
  if (tag === undefined && ids.length === 0 && classes.length === 0 && attributes.length === 0) {
    return undefined;
  }
  return { ...(tag === undefined ? {} : { tag }), ids, classes, attributes };
}

function compileSupportedSelector(selector: string): CompiledSelector | undefined {
  const split = splitSelector(selector);
  if (split === undefined) {
    return undefined;
  }
  const parts = split.compounds.map(parseCompoundSelector);
  if (parts.some((part) => part === undefined)) {
    return undefined;
  }
  return { parts: parts as CompoundSelector[], combinators: split.combinators };
}

function compileHiddenStylesheetSelectors(stylesheets: string[]): CompiledSelector[] {
  const rules = parseStylesheetRules(stylesheets);
  const variables = new Map<string, string>();
  let customPropertyCount = 0;
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => selector.toLowerCase() === ":root")) {
      continue;
    }
    for (const [property, value] of cssDeclarations(rule.declarations)) {
      if (!property.startsWith("--")) {
        continue;
      }
      customPropertyCount += 1;
      if (customPropertyCount > MAX_STYLESHEET_CUSTOM_PROPERTIES) {
        throw stylesheetLimitError(`${MAX_STYLESHEET_CUSTOM_PROPERTIES}-custom-property`);
      }
      variables.set(property, value);
    }
  }

  const compiled: CompiledSelector[] = [];
  for (const rule of rules) {
    if (!hasHiddenStyleDeclaration(rule.declarations, variables)) {
      continue;
    }
    for (const selector of rule.selectors) {
      const supported = compileSupportedSelector(selector);
      if (supported !== undefined) {
        compiled.push(supported);
      }
    }
  }
  return compiled;
}

function applyHiddenStylesheetSelectors(
  $: ReturnType<typeof load>,
  selectors: CompiledSelector[]
): void {
  if (selectors.length === 0) {
    return;
  }
  const elements = $("body *").toArray();
  type HtmlElement = (typeof elements)[number];
  let matchWork = 0;
  const chargeMatchWork = (units: number) => {
    matchWork += units;
    if (matchWork > MAX_STYLESHEET_MATCH_WORK) {
      throw stylesheetLimitError(`${MAX_STYLESHEET_MATCH_WORK}-unit matching work`);
    }
  };
  type ElementMetadata = {
    tag: string;
    id: string | undefined;
    classes: ReadonlySet<string>;
    hidden: string | undefined;
    ariaHidden: string | undefined;
  };
  const metadataCache = new WeakMap<HtmlElement, ElementMetadata>();
  const elementMetadata = (element: HtmlElement): ElementMetadata => {
    const cached = metadataCache.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const wrapped = $(element);
    const id = wrapped.attr("id");
    const classValue = wrapped.attr("class") ?? "";
    const hidden = wrapped.attr("hidden");
    const ariaHidden = wrapped.attr("aria-hidden");
    chargeMatchWork(
      1
      + (id?.length ?? 0)
      + classValue.length
      + (hidden?.length ?? 0)
      + (ariaHidden?.length ?? 0)
    );
    const metadata = {
      tag: wrapped.prop("tagName")?.toLowerCase() ?? "",
      id,
      classes: new Set(classValue.split(/\s+/).filter(Boolean)),
      hidden,
      ariaHidden
    };
    metadataCache.set(element, metadata);
    return metadata;
  };
  const matchesCompound = (element: HtmlElement, selector: CompoundSelector): boolean => {
    chargeMatchWork(
      1
      + (selector.tag?.length ?? 0)
      + selector.ids.reduce((total, id) => total + id.length, 0)
      + selector.classes.reduce((total, className) => total + className.length, 0)
      + selector.attributes.reduce(
        (total, attribute) => total + attribute.name.length + (attribute.value?.length ?? 0),
        0
      )
    );
    const metadata = elementMetadata(element);
    if (
      selector.tag !== undefined
      && selector.tag !== "*"
      && metadata.tag !== selector.tag
    ) {
      return false;
    }
    if (selector.ids.some((id) => metadata.id !== id)) {
      return false;
    }
    if (selector.classes.some((className) => !metadata.classes.has(className))) {
      return false;
    }
    return selector.attributes.every(({ name, value }) => {
      const actual = name === "hidden" ? metadata.hidden : metadata.ariaHidden;
      return actual !== undefined && (value === undefined || actual === value);
    });
  };
  const matchesSelector = (element: HtmlElement, selector: CompiledSelector): boolean => {
    let current = element;
    const lastPart = selector.parts.length - 1;
    if (!matchesCompound(current, selector.parts[lastPart]!)) {
      return false;
    }
    for (let partIndex = lastPart - 1; partIndex >= 0; partIndex -= 1) {
      const combinator = selector.combinators[partIndex]!;
      if (combinator === "child") {
        const parent = $(current).parent().get(0);
        if (parent === undefined || !matchesCompound(parent, selector.parts[partIndex]!)) {
          return false;
        }
        current = parent;
        continue;
      }
      let ancestor = $(current).parent().get(0);
      while (ancestor !== undefined && !matchesCompound(ancestor, selector.parts[partIndex]!)) {
        ancestor = $(ancestor).parent().get(0);
      }
      if (ancestor === undefined) {
        return false;
      }
      current = ancestor;
    }
    return true;
  };

  const hiddenElements: HtmlElement[] = [];
  for (const element of elements) {
    for (const selector of selectors) {
      if (matchesSelector(element, selector)) {
        hiddenElements.push(element);
        break;
      }
    }
  }
  $(hiddenElements).remove();
}

const INSTRUCTION_BLOCK_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "pre",
  "td",
  "th",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
].join(", ");

function removeAdjacentInstructionBlocks($: ReturnType<typeof load>): void {
  const blocks = $(INSTRUCTION_BLOCK_SELECTOR).toArray();
  type InstructionBlock = (typeof blocks)[number];
  const blocksToRemove = new Set<InstructionBlock>();
  let scanWork = 0;
  for (const block of blocks) {
    if (!hasMetaInstructionContext($(block).text())) {
      continue;
    }
    let nextBlock = $(block).next().get(0);
    while (nextBlock !== undefined && normalizedText($(nextBlock).text()) === "") {
      scanWork += 1;
      if (scanWork > MAX_INSTRUCTION_BLOCK_SCAN_WORK) {
        throw new Error("Public page instruction-block scan work limit exceeded");
      }
      nextBlock = $(nextBlock).next().get(0);
    }
    if (
      nextBlock !== undefined
      && SENSITIVE_ACTION_PATTERN.test(normalizedText($(nextBlock).text()))
    ) {
      blocksToRemove.add(block);
      blocksToRemove.add(nextBlock);
    }
  }
  $(Array.from(blocksToRemove)).remove();
}

function extractHtml(html: string): { title: string; text: string; html: string } {
  const $ = load(html);
  const title = sanitizedExtractedText($("title").first().text());

  const stylesheets = $("style").toArray().map((element) => $(element).text());
  const stylesheetSelectors = compileHiddenStylesheetSelectors(stylesheets);
  applyHiddenStylesheetSelectors($, stylesheetSelectors);

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
  removeAdjacentInstructionBlocks($);
  const instructionBlocks = $(INSTRUCTION_BLOCK_SELECTOR).toArray().reverse();
  for (const element of instructionBlocks) {
    if (containsInstructionLikeText($(element).text())) {
      $(element).remove();
    }
  }
  $("body *").filter((_index, element) => {
    return $(element).children().length === 0 && containsInstructionLikeText($(element).text());
  }).remove();
  $("*").each((_index, element) => {
    if (!("attribs" in element)) {
      return;
    }
    for (const attribute of Object.keys(element.attribs)) {
      if (/^on/i.test(attribute)) {
        $(element).removeAttr(attribute);
      }
    }
  });
  $("p, div, section, article, header, footer, main, nav, aside, h1, h2, h3, h4, h5, h6, li, tr")
    .append("\n");

  return {
    title,
    text: sanitizedExtractedText($("body").text()),
    html: $("body").html() ?? ""
  };
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
          ? { title: "", text: sanitizedExtractedText(body), html: "" }
          : extractHtml(body);

        return {
          url: currentUrl.href,
          title: extracted.title,
          text: extracted.text,
          html: extracted.html,
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
