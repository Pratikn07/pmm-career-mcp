import { lookup as dnsLookup } from "node:dns/promises";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { DomainError } from "../domain/errors.js";
import {
  assertFetchableUrl,
  assertFetchableUrlLocation
} from "../research/url-policy.js";

export type OpenAiFileRef = Readonly<{
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}>;

export type DownloadFileHop = Readonly<{
  statusCode: number;
  headers: Readonly<{
    location?: string;
    "content-length"?: string;
  }>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}>;

export type ResolveDownloadAddresses = (hostname: string) => Promise<string[]>;
export type RequestDownloadHop = (
  url: URL,
  address: string,
  signal: AbortSignal
) => Promise<DownloadFileHop>;

export type DownloadOpenAiFileDependencies = Readonly<{
  resolveAddresses: ResolveDownloadAddresses;
  requestHop: RequestDownloadHop;
}>;

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function mediaDownloadError(): DomainError {
  return new DomainError("MEDIA_DOWNLOAD_ERROR", "Draft image download failed");
}

function hostnameWithoutBrackets(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
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

async function defaultRequestHop(
  url: URL,
  address: string,
  signal: AbortSignal
): Promise<DownloadFileHop> {
  const hostname = hostnameWithoutBrackets(url);
  return await new Promise<DownloadFileHop>((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      agent: false,
      signal,
      headers: {
        Accept: "image/jpeg, image/png, image/gif",
        "User-Agent": "pmm-career-mcp/1.0 draft-image-downloader"
      },
      lookup: createPinnedLookup(address),
      ...(isIP(hostname) === 0 ? { servername: hostname } : {})
    }, (response) => {
      const location = response.headers.location;
      const contentLength = response.headers["content-length"];
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: {
          ...(location === undefined ? {} : { location }),
          ...(contentLength === undefined ? {} : { "content-length": contentLength })
        },
        body: response,
        destroy: () => {
          response.destroy();
        }
      });
    });
    request.once("error", reject);
    request.end();
  });
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

async function resolveHopAddresses(
  url: URL,
  resolveAddresses: ResolveDownloadAddresses,
  signal: AbortSignal
): Promise<string[]> {
  const hostname = hostnameWithoutBrackets(url);
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  return await withAbort(resolveAddresses(hostname), signal);
}

function destroyHop(response: DownloadFileHop): void {
  try {
    response.destroy();
  } catch {
    // A transport cleanup failure must not replace the safe download error.
  }
}

function declaredContentLength(response: DownloadFileHop): number | undefined {
  const value = response.headers["content-length"];
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("Invalid response length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error("Invalid response length");
  }
  return length;
}

async function readHopBody(
  response: DownloadFileHop,
  signal: AbortSignal
): Promise<Uint8Array> {
  try {
    const contentLength = declaredContentLength(response);
    if (contentLength !== undefined && contentLength > MAX_BYTES) {
      throw new Error("Response exceeds byte limit");
    }

    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    while (true) {
      const next = await withAbort(Promise.resolve(iterator.next()), signal);
      if (next.done === true) {
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new Error("Invalid response chunk");
      }
      byteLength += next.value.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength > MAX_BYTES) {
        throw new Error("Response exceeds byte limit");
      }
      chunks.push(next.value);
    }
    if (byteLength === 0) {
      throw new Error("Response body is empty");
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    destroyHop(response);
    throw error;
  }
}

function assertHttpsDownloadUrl(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error("Download URL must use HTTPS");
  }
  assertFetchableUrlLocation(url);
}

export async function downloadOpenAiFile(
  file: OpenAiFileRef,
  dependencies: Partial<DownloadOpenAiFileDependencies> = {}
): Promise<Uint8Array> {
  const resolveAddresses = dependencies.resolveAddresses ?? defaultResolveAddresses;
  const requestHop = dependencies.requestHop ?? defaultRequestHop;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timeout.unref();
  let redirectCount = 0;

  try {
    let currentUrl = new URL(file.download_url);
    while (true) {
      assertHttpsDownloadUrl(currentUrl);
      const addresses = await resolveHopAddresses(currentUrl, resolveAddresses, controller.signal);
      assertFetchableUrl(currentUrl, addresses);
      const response = await withAbort(
        requestHop(currentUrl, addresses[0]!, controller.signal),
        controller.signal
      );
      const statusCode = response.statusCode;

      if (REDIRECT_STATUSES.has(statusCode)) {
        const location = response.headers.location;
        destroyHop(response);
        if (location === undefined || redirectCount >= MAX_REDIRECTS) {
          throw new Error("Download redirect rejected");
        }
        currentUrl = new URL(location, currentUrl);
        redirectCount += 1;
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        destroyHop(response);
        throw new Error("Download response rejected");
      }
      return await readHopBody(response, controller.signal);
    }
  } catch {
    throw mediaDownloadError();
  } finally {
    clearTimeout(timeout);
  }
}
