import { afterEach, describe, expect, it, vi } from "vitest";
import { scanForSecrets } from "./secret-scan.js";

describe("scanForSecrets", () => {
  it("reports clean for content with no secrets", async () => {
    const result = await scanForSecrets("# Notes\n\nJust a normal document.\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clean).toBe(true);
      expect(result.value.findings).toEqual([]);
    }
  });

  it("detects a private key and masks the value in the finding", async () => {
    // 100+ char base64 body starting with "MI" is required for secretlint's
    // privatekey rule to match — confirmed by reproduction.
    const base64Body =
      "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
    const content = `# Notes\n\n-----BEGIN RSA PRIVATE KEY-----\n${base64Body}\n-----END RSA PRIVATE KEY-----\n`;

    const result = await scanForSecrets(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clean).toBe(false);
      expect(result.value.findings.length).toBeGreaterThan(0);
      expect(result.value.findings[0]?.ruleId).toBe("@secretlint/secretlint-rule-privatekey");
      // The finding must never carry the raw secret value.
      expect(result.value.findings[0]?.message).not.toContain(base64Body);
      expect(JSON.stringify(result.value)).not.toContain(base64Body);
    }
  });

  it("detects an iroha session token (ist_) via the targeted pattern rule", async () => {
    // The recommend preset has no rule for iroha's own `ist_<43 base64url>`
    // session token (checkpoint.ts `sessionTokenSchema`); the added
    // secretlint-rule-pattern entry closes that specific gap. Goes red without
    // the pattern rule in the engine config.
    const token = `ist_${"A".repeat(43)}`;
    const result = await scanForSecrets(`# Notes\n\nsession: ${token}\n`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clean).toBe(false);
      expect(
        result.value.findings.some((f) => f.ruleId === "@secretlint/secretlint-rule-pattern"),
      ).toBe(true);
      // The finding must never carry the raw token value (maskSecrets).
      expect(result.value.findings.every((f) => !f.message.includes(token))).toBe(true);
      expect(JSON.stringify(result.value)).not.toContain(token);
    }
  });

  it("does not flag an ist_-prefixed string that is too short to be a token", async () => {
    // Guards against over-matching: the `{43}` length is exact, so a 42-char
    // suffix must not trip the rule (no blanket entropy false-positive).
    const result = await scanForSecrets(`# Notes\n\nist_${"A".repeat(42)}\n`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clean).toBe(true);
    }
  });
});

describe("scanForSecrets engine retry", () => {
  afterEach(() => {
    vi.doUnmock("@secretlint/node");
    vi.resetModules();
  });

  it("retries engine creation on the next call after a transient createEngine failure", async () => {
    // Regression test (confirmed by review): the module-level engine
    // promise must not permanently pin a rejected `createEngine()` call —
    // otherwise one transient failure (e.g. a filesystem hiccup resolving
    // a rule package) would break every future scan for the rest of the
    // process's life. `@secretlint/node` is a third-party dependency, so
    // mocking it here (unlike this project's own filesystem/subprocess
    // code) is the only way to force a specific, real failure mode.
    let callCount = 0;
    vi.doMock("@secretlint/node", () => ({
      createEngine: vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(new Error("transient failure"));
        }
        return Promise.resolve({
          executeOnContent: async () => ({
            ok: true,
            output: JSON.stringify([{ messages: [] }]),
          }),
        });
      }),
    }));
    vi.resetModules();
    const { scanForSecrets: scanForSecretsWithMock } = await import("./secret-scan.js");

    const first = await scanForSecretsWithMock("# Notes\n");
    expect(first.ok).toBe(false);

    const second = await scanForSecretsWithMock("# Notes\n");
    expect(second.ok).toBe(true);
    expect(callCount).toBe(2);
  });
});
