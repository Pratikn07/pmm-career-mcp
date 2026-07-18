import { isIP, isIPv4, isIPv6 } from "node:net";

function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function isIpv4Prefix(address: number, network: string, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) === (ipv4Number(network) & mask);
}

function isPublicIpv4(address: string): boolean {
  const numeric = ipv4Number(address);
  const nonPublicRanges: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ];
  return !nonPublicRanges.some(([network, prefix]) => isIpv4Prefix(numeric, network, prefix));
}

function parseIpv6(address: string): number[] {
  let normalized = address.toLowerCase();
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail !== undefined) {
    const numeric = ipv4Number(ipv4Tail);
    normalized = `${normalized.slice(0, -ipv4Tail.length)}${(numeric >>> 16).toString(16)}:${(
      numeric & 0xffff
    ).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    throw new Error("Invalid IPv6 address");
  }
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) {
    throw new Error("Invalid IPv6 address");
  }
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: omitted }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16))
  ];
}

function hasIpv6Prefix(parts: number[], prefixAddress: string, prefixLength: number): boolean {
  const prefix = parseIpv6(prefixAddress);
  const completeParts = Math.floor(prefixLength / 16);
  for (let index = 0; index < completeParts; index += 1) {
    if (parts[index] !== prefix[index]) {
      return false;
    }
  }
  const remainingBits = prefixLength % 16;
  if (remainingBits === 0) {
    return true;
  }
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (parts[completeParts]! & mask) === (prefix[completeParts]! & mask);
}

function isExactIpv6(parts: number[], address: string): boolean {
  const expected = parseIpv6(address);
  return parts.every((part, index) => part === expected[index]);
}

// Offline policy reviewed against the IANA IPv6 Global Unicast Address Space registry updated
// 2025-10-10 and the Special-Purpose Address Registry updated 2025-10-09. Unlisted 2000::/3
// space is reserved, so allow only allocated prefixes and the explicitly global exceptions
// inside the otherwise non-global 2001::/23 protocol-assignment block.
function isPublicIpv6(address: string): boolean {
  const parts = parseIpv6(address);
  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (isMappedIpv4) {
    return false;
  }

  if (hasIpv6Prefix(parts, "2001::", 23)) {
    const globallyReachableExceptions: ReadonlyArray<readonly [string, number]> = [
      ["2001:3::", 32],
      ["2001:4:112::", 48],
      ["2001:20::", 28],
      ["2001:30::", 28]
    ];
    return ["2001:1::1", "2001:1::2", "2001:1::3"].some((value) => isExactIpv6(parts, value))
      || globallyReachableExceptions.some(
        ([prefix, length]) => hasIpv6Prefix(parts, prefix, length)
      );
  }

  const nonGlobalRanges: ReadonlyArray<readonly [string, number]> = [
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20]
  ];
  if (nonGlobalRanges.some(([prefix, length]) => hasIpv6Prefix(parts, prefix, length))) {
    return false;
  }

  const allocatedGlobalUnicastRanges: ReadonlyArray<readonly [string, number]> = [
    ["2001:200::", 23],
    ["2001:400::", 23],
    ["2001:600::", 23],
    ["2001:800::", 22],
    ["2001:c00::", 23],
    ["2001:e00::", 23],
    ["2001:1200::", 23],
    ["2001:1400::", 22],
    ["2001:1800::", 23],
    ["2001:1a00::", 23],
    ["2001:1c00::", 22],
    ["2001:2000::", 19],
    ["2001:4000::", 23],
    ["2001:4200::", 23],
    ["2001:4400::", 23],
    ["2001:4600::", 23],
    ["2001:4800::", 23],
    ["2001:4a00::", 23],
    ["2001:4c00::", 23],
    ["2001:5000::", 20],
    ["2001:8000::", 19],
    ["2001:a000::", 20],
    ["2001:b000::", 20],
    ["2003::", 18],
    ["2400::", 12],
    ["2410::", 12],
    ["2600::", 12],
    ["2610::", 23],
    ["2620::", 23],
    ["2630::", 12],
    ["2800::", 12],
    ["2a00::", 12],
    ["2a10::", 12],
    ["2c00::", 12]
  ];
  return allocatedGlobalUnicastRanges.some(
    ([prefix, length]) => hasIpv6Prefix(parts, prefix, length)
  );
}

function assertPublicIp(address: string): void {
  if (isIPv4(address)) {
    if (isPublicIpv4(address)) {
      return;
    }
  } else if (isIPv6(address)) {
    if (isPublicIpv6(address)) {
      return;
    }
  } else {
    throw new Error(`DNS returned an invalid IP address: ${address}`);
  }
  throw new Error(`URL must resolve only to public network addresses; rejected ${address}`);
}

export function assertFetchableUrlLocation(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL scheme must be HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URL credentials are not allowed");
  }

  const hostname = normalizedHostname(url.hostname);
  if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) {
    throw new Error("Fetching LinkedIn pages is not allowed");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Localhost URLs are not allowed");
  }
  if (hostname === "") {
    throw new Error("URL must contain a hostname");
  }

  if (isIP(hostname) !== 0) {
    assertPublicIp(hostname);
  }
}

export function assertFetchableUrl(url: URL, resolvedAddresses: string[]): void {
  assertFetchableUrlLocation(url);
  if (resolvedAddresses.length === 0) {
    throw new Error("URL hostname must resolve to at least one public address");
  }
  for (const address of resolvedAddresses) {
    assertPublicIp(normalizedHostname(address));
  }
}
