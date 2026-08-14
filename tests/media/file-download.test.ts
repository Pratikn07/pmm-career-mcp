import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  downloadOpenAiFile,
  type DownloadFileHop,
  type DownloadOpenAiFileDependencies,
  type OpenAiFileRef
} from "../../src/media/file-download.js";

const MAX_BYTES = 20 * 1024 * 1024;
const PUBLIC_IPV4 = "93.184.216.34";
const PUBLIC_IPV6 = "2606:4700:4700::1111";
const PRIVATE_URL = "https://files.openai.example/download/private-token-in-url";
const PRIVATE_FILE_ID = "file-private-id-that-must-not-leak";

const file: OpenAiFileRef = {
  download_url: PRIVATE_URL,
  file_id: PRIVATE_FILE_ID,
  mime_type: "image/png",
  file_name: "draft.png"
};

type HopHeaders = Readonly<{
  location?: string;
  "content-length"?: string;
}>;

function hop(
  statusCode: number,
  chunks: readonly Uint8Array[] = [],
  headers: HopHeaders = {}
): DownloadFileHop {
  return {
    statusCode,
    headers,
    body: Readable.from(chunks),
    destroy: vi.fn()
  };
}

function dependencies(
  requestHop: DownloadOpenAiFileDependencies["requestHop"],
  resolveAddresses: DownloadOpenAiFileDependencies["resolveAddresses"] = async () => [PUBLIC_IPV4]
): DownloadOpenAiFileDependencies {
  return { resolveAddresses, requestHop };
}

async function expectSafeDownloadError(
  action: () => Promise<unknown>,
  forbiddenValues: readonly string[] = []
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe("MEDIA_DOWNLOAD_ERROR");
    expect(domainError.message).toBe("Draft image download failed");
    expect(domainError.details).toEqual({});
    expect(Object.hasOwn(domainError, "cause")).toBe(false);
    const visibleError = `${domainError.message}\n${domainError.stack ?? ""}\n${JSON.stringify(domainError)}`;
    for (const value of [PRIVATE_URL, PRIVATE_FILE_ID, ...forbiddenValues]) {
      expect(visibleError).not.toContain(value);
    }
    return domainError;
  }
  throw new Error("Expected a DomainError");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("downloadOpenAiFile", () => {
  it("pins the default HTTPS transport to each validated address with fresh redirect requests", async () => {
    const responses = [
      Object.assign(Readable.from([]), {
        statusCode: 302,
        headers: { location: "https://next.example/image.png" }
      }),
      Object.assign(Readable.from([Uint8Array.of(1, 2, 3)]), {
        statusCode: 200,
        headers: {}
      })
    ];
    const requests: EventEmitter[] = [];
    const httpsRequest = vi.fn(((url: URL, options: https.RequestOptions, callback: (response: never) => void) => {
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = () => callback(responses.shift() as never);
      requests.push(request);
      return request;
    }) as unknown as typeof https.request);
    const resolveAddresses = vi.fn(async (hostname: string) => (
      hostname === "next.example" ? [PUBLIC_IPV6] : [PUBLIC_IPV4]
    ));

    await expect(downloadOpenAiFile(file, {
      resolveAddresses,
      httpsRequest: httpsRequest as unknown as typeof https.request
    }))
      .resolves.toEqual(Uint8Array.of(1, 2, 3));

    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(requests[0]).not.toBe(requests[1]);
    const calls = httpsRequest.mock.calls as unknown as Array<[URL, https.RequestOptions]>;
    expect(calls.map(([url]) => url.hostname)).toEqual(["files.openai.example", "next.example"]);
    for (const [index, [, options]] of calls.entries()) {
      const hostname = index === 0 ? "files.openai.example" : "next.example";
      const address = index === 0 ? PUBLIC_IPV4 : PUBLIC_IPV6;
      expect(options).toMatchObject({
        method: "GET",
        agent: false,
        servername: hostname,
        headers: expect.objectContaining({ Host: hostname })
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const lookup = options.lookup!;
      const all = await new Promise<unknown>((resolve, reject) => lookup(
        hostname,
        { all: true },
        (error, result) => error ? reject(error) : resolve(result)
      ));
      expect(all).toEqual([{ address, family: index === 0 ? 4 : 6 }]);
      const single = await new Promise<unknown>((resolve, reject) => lookup(
        hostname,
        {},
        (error, result, family) => error ? reject(error) : resolve({ address: result, family })
      ));
      expect(single).toEqual({ address, family: index === 0 ? 4 : 6 });
      await expect(new Promise((resolve, reject) => lookup(
        "rebound.example",
        {},
        (error, result) => error ? reject(error) : resolve(result)
      ))).rejects.toThrow("hostname");
    }
  });

  it("downloads an HTTPS file through one selected address only after validating every DNS answer", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const resolveAddresses = vi.fn(async () => [PUBLIC_IPV4, PUBLIC_IPV6]);
    const requestHop = vi.fn(async (url: URL, address: string, signal: AbortSignal) => {
      expect(url.href).toBe(PRIVATE_URL);
      expect(address).toBe(PUBLIC_IPV4);
      expect(signal.aborted).toBe(false);
      return hop(200, [bytes.subarray(0, 2), bytes.subarray(2)]);
    });

    await expect(downloadOpenAiFile(file, dependencies(requestHop, resolveAddresses)))
      .resolves.toEqual(bytes);

    expect(resolveAddresses).toHaveBeenCalledTimes(1);
    expect(resolveAddresses).toHaveBeenCalledWith("files.openai.example");
    expect(requestHop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTTP", "http://files.openai.example/private"],
    ["URL credentials", "https://private-user:private-password@files.openai.example/private"],
    ["an invalid absolute URL", "not-a-url"]
  ])("rejects %s before DNS or transport", async (_label, downloadUrl) => {
    const resolveAddresses = vi.fn(async () => [PUBLIC_IPV4]);
    const requestHop = vi.fn(async () => hop(200, [Uint8Array.of(1)]));

    await expectSafeDownloadError(
      () => downloadOpenAiFile({ ...file, download_url: downloadUrl }, {
        resolveAddresses,
        requestHop
      }),
      [downloadUrl]
    );

    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(requestHop).not.toHaveBeenCalled();
  });

  it.each([
    ["IPv4 unspecified", "0.0.0.0"],
    ["IPv4 private", "10.0.0.8"],
    ["IPv4 shared", "100.64.0.1"],
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 link-local", "169.254.169.254"],
    ["IPv4 reserved protocol", "192.0.0.1"],
    ["IPv4 documentation", "192.0.2.1"],
    ["IPv4 benchmarking", "198.18.0.1"],
    ["IPv4 multicast", "224.0.0.1"],
    ["IPv4 reserved", "240.0.0.1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv6 mapped IPv4", "::ffff:127.0.0.1"],
    ["IPv6 protocol-reserved", "2001:10::1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["IPv6 unallocated", "2200::1"],
    ["IPv6 unique-local", "fd12:3456:789a::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 multicast", "ff02::1"]
  ])("rejects a non-public %s DNS answer before transport", async (_label, address) => {
    const requestHop = vi.fn(async () => hop(200, [Uint8Array.of(1)]));

    await expectSafeDownloadError(
      () => downloadOpenAiFile(file, dependencies(requestHop, async () => [address])),
      [address]
    );

    expect(requestHop).not.toHaveBeenCalled();
  });

  it("rejects the whole hop when any DNS answer is unsafe", async () => {
    const requestHop = vi.fn(async () => hop(200, [Uint8Array.of(1)]));

    await expectSafeDownloadError(() => downloadOpenAiFile(
      file,
      dependencies(requestHop, async () => [PUBLIC_IPV4, "127.0.0.1"])
    ));

    expect(requestHop).not.toHaveBeenCalled();
  });

  it("re-resolves the same hostname after a redirect and blocks DNS rebinding", async () => {
    const answers = [[PUBLIC_IPV4], ["127.0.0.1"]];
    const resolveAddresses = vi.fn(async () => answers.shift() ?? []);
    const firstHop = hop(302, [], { location: "/rebound" });
    const requestHop = vi.fn(async () => firstHop);

    await expectSafeDownloadError(() => downloadOpenAiFile(
      file,
      dependencies(requestHop, resolveAddresses)
    ));

    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(requestHop).toHaveBeenCalledTimes(1);
    expect(firstHop.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an HTTP target", "http://redirected.example/private"],
    ["a credential-bearing target", "https://user:password@redirected.example/private"],
    ["a private IP literal", "https://127.0.0.1/private"]
  ])("validates redirects and refuses %s before another request", async (_label, location) => {
    const firstHop = hop(302, [], { location });
    const requestHop = vi.fn(async () => firstHop);

    await expectSafeDownloadError(
      () => downloadOpenAiFile(file, dependencies(requestHop)),
      [location]
    );

    expect(requestHop).toHaveBeenCalledTimes(1);
    expect(firstHop.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])("follows HTTP %i and revalidates the next hop", async (status) => {
    const responses = [
      hop(status, [], { location: "https://next.example/image" }),
      hop(200, [Uint8Array.of(status % 256)])
    ];
    const resolveAddresses = vi.fn(async (hostname: string) => (
      hostname === "next.example" ? [PUBLIC_IPV6] : [PUBLIC_IPV4]
    ));
    const requestHop = vi.fn(async () => responses.shift()!);

    await expect(downloadOpenAiFile(file, dependencies(requestHop, resolveAddresses)))
      .resolves.toEqual(Uint8Array.of(status % 256));

    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(requestHop).toHaveBeenCalledTimes(2);
  });

  it("allows no more than three redirects", async () => {
    const responses = Array.from({ length: 4 }, (_value, index) => hop(302, [], {
      location: `/redirect-${index + 1}`
    }));
    const requestHop = vi.fn(async () => responses.shift()!);

    await expectSafeDownloadError(() => downloadOpenAiFile(file, dependencies(requestHop)));

    expect(requestHop).toHaveBeenCalledTimes(4);
  });

  it("aborts the complete download after ten seconds", async () => {
    vi.useFakeTimers();
    const requestHop = vi.fn(async (_url: URL, _address: string, signal: AbortSignal) => (
      await new Promise<DownloadFileHop>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("low-level timeout cause")), {
          once: true
        });
      })
    ));

    const result = downloadOpenAiFile(file, dependencies(requestHop));
    const rejection = expectSafeDownloadError(() => result, ["low-level timeout cause"]);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
  });

  it("rejects an empty successful response", async () => {
    await expectSafeDownloadError(() => downloadOpenAiFile(
      file,
      dependencies(async () => hop(200))
    ));
  });

  it("accepts exactly 20 MiB and rejects streaming byte 20,971,521", async () => {
    const atLimit = new Uint8Array(MAX_BYTES);
    await expect(downloadOpenAiFile(
      file,
      dependencies(async () => hop(200, [atLimit]))
    )).resolves.toHaveLength(MAX_BYTES);

    const overLimitHop = hop(200, [atLimit, Uint8Array.of(1)]);
    await expectSafeDownloadError(() => downloadOpenAiFile(
      file,
      dependencies(async () => overLimitHop)
    ));
    expect(overLimitHop.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized declared response before consuming its body", async () => {
    let bodyRead = false;
    const response: DownloadFileHop = {
      statusCode: 200,
      headers: { "content-length": String(MAX_BYTES + 1) },
      body: {
        async *[Symbol.asyncIterator]() {
          bodyRead = true;
          yield Uint8Array.of(1);
        }
      },
      destroy: vi.fn()
    };

    await expectSafeDownloadError(() => downloadOpenAiFile(
      file,
      dependencies(async () => response)
    ));

    expect(bodyRead).toBe(false);
    expect(response.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not expose provider failures, response bodies, or low-level causes", async () => {
    const providerSecret = "private-provider-error-body";
    const requestHop = vi.fn(async () => {
      throw new Error(providerSecret);
    });

    await expectSafeDownloadError(
      () => downloadOpenAiFile(file, dependencies(requestHop)),
      [providerSecret]
    );

    await expectSafeDownloadError(
      () => downloadOpenAiFile(file, dependencies(async () => hop(
        403,
        [Buffer.from(providerSecret)]
      ))),
      [providerSecret]
    );
  });
});
