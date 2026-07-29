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

  // Each list is transcribed from the declaration that produces the value, named
  // beside it — never from the catalog, which would make this check circular and
  // pass on exactly the omission it exists to catch.
  it.each([
    // migrations/001_initial.sql event_log.outcome
    ["evoutcome", ["success", "warning", "failure", "denied"]],
    // packages/core/src/doctor.ts DoctorCheckStatus
    ["dcheck", ["ok", "warning", "error", "blocked"]],
    // migrations/001_initial.sql candidates.candidate_type
    [
      "ktype",
      [
        "session_summary",
        "decision",
        "rule",
        "concept",
        "insight",
        "incident",
        "pattern",
        "review_learning",
      ],
    ],
  ])("covers every %s value", (prefix, values) => {
    for (const value of values) {
      expect(messages.ja[`${prefix}.${value}`], `ja is missing ${prefix}.${value}`).toBeDefined();
      expect(messages.en[`${prefix}.${value}`], `en is missing ${prefix}.${value}`).toBeDefined();
    }
  });
});
