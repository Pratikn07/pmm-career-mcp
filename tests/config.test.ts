import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps publishing disabled by default", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.linkedinPublishEnabled).toBe(false);
  });

  it("rejects no-auth production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      AUTH_MODE: "none",
      TOKEN_ENCRYPTION_KEY: "x".repeat(64)
    })).toThrow(/AUTH_MODE/);
  });
});
