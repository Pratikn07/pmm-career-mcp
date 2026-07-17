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

function isPublicIpv6(address: string): boolean {
  const parts = parseIpv6(address);
  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (isMappedIpv4) {
    const mapped = `${parts[6]! >>> 8}.${parts[6]! & 0xff}.${parts[7]! >>> 8}.${parts[7]! & 0xff}`;
    return isPublicIpv4(mapped);
  }

  const [first, second] = parts;
  if (first === undefined || second === undefined || (first & 0xe000) !== 0x2000) {
    return false;
  }

  const isTeredo = first === 0x2001 && second === 0;
  const isDocumentation = first === 0x2001 && second === 0x0db8;
  const isBenchmark = first === 0x2001 && second === 0x0002;
  const isSixToFour = first === 0x2002;
  return !isTeredo && !isDocumentation && !isBenchmark && !isSixToFour;
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
