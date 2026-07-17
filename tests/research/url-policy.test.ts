import { describe, expect, it } from "vitest";
import { assertFetchableUrl } from "../../src/research/url-policy.js";

describe("assertFetchableUrl", () => {
  it.each([
    ["ftp://acme.example/team", ["93.184.216.34"]],
    ["https://user:secret@acme.example/team", ["93.184.216.34"]],
    ["https://www.linkedin.com/in/example", ["108.174.10.10"]],
    ["https://careers.linkedin.com/jobs", ["108.174.10.10"]],
    ["https://linkedin.com./company/example", ["108.174.10.10"]],
    ["http://localhost/admin", ["127.0.0.1"]],
    ["http://service.localhost/admin", ["127.0.0.1"]]
  ])("rejects an unsafe URL target %s", (raw, addresses) => {
    expect(() => assertFetchableUrl(new URL(raw), addresses)).toThrow();
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1"
  ])("rejects a non-public IPv4 destination %s", (address) => {
    expect(() => assertFetchableUrl(new URL("https://acme.example/team"), [address])).toThrow(
      /public/i
    );
  });

  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "ff02::1"
  ])("rejects a non-public IPv6 destination %s", (address) => {
    expect(() => assertFetchableUrl(new URL("https://acme.example/team"), [address])).toThrow(
      /public/i
    );
  });

  it("rejects a private IP literal even if supplied DNS results appear public", () => {
    expect(() => assertFetchableUrl(new URL("http://127.0.0.1/admin"), ["93.184.216.34"]))
      .toThrow(/public/i);
  });

  it.for<string[]>([
    [],
    ["not-an-ip"],
    ["93.184.216.34", "127.0.0.1"]
  ])("fails closed on anomalous DNS results %#", (addresses) => {
    expect(() => assertFetchableUrl(new URL("https://acme.example/team"), addresses)).toThrow();
  });

  it.each([
    ["https://acme.example/team", ["93.184.216.34"]],
    ["http://acme.example/team", ["2606:2800:220:1:248:1893:25c8:1946"]],
    ["https://acme.example/team", ["::ffff:93.184.216.34"]]
  ])("allows a public HTTP(S) target %s", (raw, addresses) => {
    expect(() => assertFetchableUrl(new URL(raw), addresses)).not.toThrow();
  });
});
