import { describe, expect, it } from "vitest";
import { buildMatchQuery } from "./fts-candidates.js";

describe("buildMatchQuery", () => {
  it("quotes a single token as an opaque phrase", () => {
    expect(buildMatchQuery("libSQL")).toBe('"libSQL"');
  });

  it("joins natural-language words with OR for recall", () => {
    expect(buildMatchQuery("repository pattern")).toBe('"repository" OR "pattern"');
  });

  it("joins identifier/path tokens with AND for precision", () => {
    expect(buildMatchQuery("src/generated codegen")).toBe('"src/generated" AND "codegen"');
    expect(buildMatchQuery("upsertEntity storage")).toBe('"upsertEntity" AND "storage"');
  });

  it("escapes embedded double quotes so text can never become an operator", () => {
    expect(buildMatchQuery('a"b')).toBe('"a""b"');
  });

  it("splits a Latin run glued to a CJK run at the script boundary", () => {
    expect(buildMatchQuery("なぜrepository")).toBe('"なぜ" OR "repository"');
    expect(buildMatchQuery("patternを使うのか")).toBe('"pattern" OR "を使うのか"');
  });

  it("splits a fully glued mixed-script natural-language query", () => {
    expect(buildMatchQuery("なぜrepository patternを使うのか")).toBe(
      '"なぜ" OR "repository" OR "pattern" OR "を使うのか"',
    );
  });

  it("splits a CJK run from an adjacent digit run", () => {
    expect(buildMatchQuery("パターン2")).toBe('"パターン" OR "2"');
  });

  it("splits before a Latin run after a prolonged sound mark (U+30FC is Script=Common)", () => {
    expect(buildMatchQuery("ユーザーID")).toBe('"ユーザー" OR "ID"');
    expect(buildMatchQuery("サーバーURL 設定")).toBe('"サーバー" OR "URL" OR "設定"');
  });

  it("routes a mixed-script query to OR even when a Latin token looks like an identifier", () => {
    // `libSQL` is camelCase (an exact-token marker), but the query also has kana
    // runs that only ever match as whole-run tokens; AND would require those to
    // match and collapse recall to zero, so a CJK run forces OR.
    expect(buildMatchQuery("libSQLを使う理由")).toBe('"libSQL" OR "を使う理由"');
    expect(buildMatchQuery("getUserById のバグ")).toBe('"getUserById" OR "のバグ"');
  });

  it("leaves a Latin/digit run with internal case or dots intact", () => {
    expect(buildMatchQuery("voyage-4-large")).toBe('"voyage-4-large"');
    expect(buildMatchQuery("v0.1")).toBe('"v0.1"');
  });
});
