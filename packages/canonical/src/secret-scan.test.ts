import { describe, expect, it } from "vitest";
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
});
