import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoctorReport, runDoctor } from "@iroha/core";
import { runGit } from "@iroha/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../index.js";
import { formatDoctor, sectionsFor } from "./doctor.js";

// Duplicated from `index.test.ts` rather than extracted: a shared helper would live
// outside `*.test.ts`, and only test files are exempt from the package-boundary rule
// that forbids `@iroha/git` here. Two copies is also one short of the threshold this
// repository sets for abstracting.
async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iroha-cli-test-"));
  await runGit(["init", "--initial-branch=main"], { cwd: dir });
  await runGit(["config", "user.email", "iroha-test@example.com"], { cwd: dir });
  await runGit(["config", "user.name", "iroha test"], { cwd: dir });
  return dir;
}

/** Bounded, best-effort: Windows holds libSQL file handles past close. */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

const EMOJI = /\p{Emoji_Presentation}|️/u;

function report(checks: DoctorReport["checks"]): DoctorReport {
  return { checks };
}

describe("sectionsFor", () => {
  let repoDir: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  /**
   * Runs the actual doctor rather than a hand-copied list of names: a check added
   * in `@iroha/core` with no entry in the CLI's mapping has to fail here, and a
   * fixture list would go stale silently instead.
   *
   * It runs against a *temporary* repository, never `process.cwd()`. Pointed at the
   * developer's own checkout, `runDoctor` opens the live `.git/iroha/index.db` four
   * times and `probeCapabilities` puts roughly twenty DDL statements through it —
   * measured as `PRAGMA schema_version` moving by 20 across one run. Worse, it
   * contends for the write lock with the Hook and MCP writers: under contention
   * `probeCapabilities` swallows `SQLITE_BUSY` and reports FTS and vector search
   * unsupported on a working build, and in the other direction a hook that loses
   * the race drops its checkpoint, because hook failure is fail-open.
   *
   * The temp repo must be initialized, or `runDoctor` returns early at the
   * `iroha-init` check and the completeness assertion silently narrows to the first
   * few names while still passing.
   *
   * Timeout: this spawns git, claude and codex (5 s each) plus several libSQL
   * connections, which does not fit vitest's 5 s default.
   */
  it("files every check the real doctor emits, so a new one is never dropped", {
    timeout: 30_000,
  }, async () => {
    repoDir = await createTempGitRepo();
    process.chdir(repoDir);
    await runCli(["init", "--json"]);

    const result = await runDoctor(repoDir);
    expect(result.ok, `doctor failed: ${result.ok ? "" : result.error.code}`).toBe(true);
    if (!result.ok) return;

    const emitted = result.value.checks.map((check) => check.name);
    // Pins the early-return degradation: these are the checks that only run once
    // `iroha-init` has passed, so their presence proves the full set was reached.
    expect(emitted).toContain("storage-capabilities");
    expect(emitted).toContain("retention");

    const sections = sectionsFor(result.value);
    const filed = sections.flatMap((section) => section.checks.map((check) => check.name));

    expect(filed.sort()).toEqual([...emitted].sort());
    expect(sections.some((section) => section.label === "Other")).toBe(false);
  });

  it("puts an unmapped check under Other rather than hiding it", () => {
    const sections = sectionsFor(
      report([
        { name: "node", status: "ok", message: "Node.js v24" },
        { name: "something-new", status: "warning", message: "unmapped" },
      ]),
    );

    const other = sections.find((section) => section.label === "Other");
    expect(other?.checks.map((check) => check.name)).toEqual(["something-new"]);
  });

  it("drops a section whose checks are all absent", () => {
    const sections = sectionsFor(report([{ name: "node", status: "ok", message: "Node.js v24" }]));

    expect(sections.map((section) => section.label)).toEqual(["Environment"]);
  });

  it("orders checks within a section by the mapping, not by report order", () => {
    const sections = sectionsFor(
      report([
        { name: "claude", status: "ok", message: "" },
        { name: "node", status: "ok", message: "" },
        { name: "git", status: "ok", message: "" },
      ]),
    );

    expect(sections[0]?.checks.map((check) => check.name)).toEqual(["node", "git", "claude"]);
  });
});

describe("formatDoctor", () => {
  const sample = report([
    { name: "node", status: "ok", message: "Node.js v24.18.0" },
    { name: "codex", status: "warning", message: "codex was not found on PATH" },
    { name: "git-repository", status: "error", message: "not a git repository" },
  ]);

  it("uses no emoji", () => {
    expect(EMOJI.test(formatDoctor({ doctor: sample }))).toBe(false);
  });

  it("names the worst status in the verdict", () => {
    expect(formatDoctor({ doctor: sample })).toContain("action needed");
    expect(
      formatDoctor({
        doctor: report([{ name: "node", status: "warning", message: "old" }]),
      }),
    ).toContain("warnings only");
    expect(
      formatDoctor({ doctor: report([{ name: "node", status: "ok", message: "fine" }]) }),
    ).toContain("all clear");
  });

  /**
   * Severity order, not first-appearance order: a Map keyed by insertion put
   * `warning 1 · ok 12` on a report whose first check happened to be a warning, and
   * a `toContain("ok 1")` assertion passed either way.
   */
  it("tallies in a fixed severity order regardless of report order", () => {
    const text = formatDoctor({
      doctor: report([
        { name: "codex", status: "warning", message: "" },
        { name: "node", status: "ok", message: "" },
        { name: "git", status: "ok", message: "" },
      ]),
    });

    expect(text).toContain("ok 2 · warning 1");
  });

  it("shows every check's name and message", () => {
    const text = formatDoctor({ doctor: sample });

    for (const check of sample.checks) {
      expect(text, check.name).toContain(check.name);
      expect(text, check.message).toContain(check.message);
    }
  });

  it("strips control characters out of a check message", () => {
    const text = formatDoctor({
      doctor: report([
        { name: "node", status: "ok", message: `Node.js${String.fromCharCode(27)}[2K v24` },
      ]),
    });

    expect(text).not.toContain(String.fromCharCode(27));
  });
});
