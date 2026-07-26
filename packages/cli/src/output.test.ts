import { afterEach, describe, expect, it, vi } from "vitest";
import { printError, printSuccess } from "./output.js";

describe("printSuccess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * `--json` is the machine contract — `scripts/release-smoke.mjs` parses `doctor
   * --json`. Asserting the *absence of escape sequences* would prove nothing here,
   * because colour is off in a non-TTY test process anyway; the guarantee worth
   * holding is structural: in JSON mode the styled formatter is never reached.
   */
  it("never invokes the text formatter in JSON mode", () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const formatText = vi.fn(() => "styled");

    printSuccess(true, { doctor: { checks: [] } }, formatText);

    expect(formatText).not.toHaveBeenCalled();
  });

  it("serializes the data verbatim under an ok envelope in JSON mode", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    printSuccess(true, { hits: [{ id: "dec_1" }] }, () => "styled");

    const parsed = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""));
    expect(parsed).toEqual({ ok: true, hits: [{ id: "dec_1" }] });
  });

  it("writes only the formatter's output in human mode", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    printSuccess(false, { hits: [] }, () => "  ●●●  iroha search");

    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toBe("  ●●●  iroha search\n");
  });
});

describe("printError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("includes the error code and details in human (stderr) output", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    printError(false, {
      code: "NOT_INITIALIZED",
      message: "run `iroha init` first",
      details: { repositoryId: "repo_x" },
    });
    const out = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(out).toContain("Error [NOT_INITIALIZED]: run `iroha init` first");
    expect(out).toContain('Details: {"repositoryId":"repo_x"}');
    expect(process.exitCode).toBe(1);
  });

  it("includes the error code and details in JSON (stdout) output", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    printError(true, { code: "CONFLICT", message: "stale token", details: { revision: 2 } });
    const parsed = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFLICT");
    expect(parsed.error.details).toEqual({ revision: 2 });
  });

  it("omits details entirely when the error has none", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    printError(true, { code: "INTERNAL_ERROR", message: "boom" });
    const parsed = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""));
    expect("details" in parsed.error).toBe(false);
  });
});
