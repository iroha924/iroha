import { describe, expect, it } from "vitest";
import { messages } from "./index.js";

/**
 * `t()` falls back to the key itself, so a key present in one catalog and absent
 * from the other reaches the user as `runstatus.active` rather than as a label.
 * Nothing else in the suite reads the `ja` catalog, which renders only when the
 * repository sets `default_language: ja`.
 */
describe("message catalogs", () => {
  it("define exactly the same keys in both locales", () => {
    const ja = Object.keys(messages.ja).sort();
    const en = Object.keys(messages.en).sort();
    expect(ja.filter((k) => !messages.en[k])).toEqual([]);
    expect(en.filter((k) => !messages.ja[k])).toEqual([]);
    expect(ja).toEqual(en);
  });

  it("leaves no value empty", () => {
    for (const [locale, dict] of Object.entries(messages)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.length, `${locale}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  // The badge labels this repository renders from database enum values. A value
  // arriving with no key is the defect these keys were added to fix, so the list
  // is pinned rather than derived from the catalog it is checking.
  it.each([
    ["runstatus", ["active", "completed", "interrupted", "abandoned", "failed"]],
    ["outcome", ["completed", "partial", "blocked", "no_change"]],
    ["vresult", ["passed", "failed", "not_run"]],
    ["reftype", ["issue", "pull_request", "review", "commit", "file", "symbol", "url", "document"]],
    ["evoutcome", ["success", "warning", "failure", "denied"]],
    ["dcheck", ["ok", "warning", "error"]],
    ["ktype", ["decision", "rule", "concept", "insight", "incident", "pattern", "review_learning"]],
    ["platform", ["claude_code", "codex"]],
  ])("covers every %s value", (prefix, values) => {
    for (const value of values) {
      expect(messages.ja[`${prefix}.${value}`], `ja is missing ${prefix}.${value}`).toBeDefined();
      expect(messages.en[`${prefix}.${value}`], `en is missing ${prefix}.${value}`).toBeDefined();
    }
  });
});
