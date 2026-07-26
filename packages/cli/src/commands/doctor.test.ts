import { type DoctorReport, runDoctor } from "@iroha/core";
import { describe, expect, it } from "vitest";
import { formatDoctor, sectionsFor } from "./doctor.js";

const EMOJI = /\p{Emoji_Presentation}|️/u;

function report(checks: DoctorReport["checks"]): DoctorReport {
  return { checks };
}

describe("sectionsFor", () => {
  it("files every check the real doctor emits, so a new one is never dropped", async () => {
    // Runs the actual doctor rather than a fixture list: a check added in
    // `@iroha/core` with no entry in the CLI's mapping must fail here, and a
    // hand-copied list of names would go stale silently instead.
    const result = await runDoctor(process.cwd());
    expect(result.ok, `doctor failed: ${result.ok ? "" : result.error.code}`).toBe(true);
    if (!result.ok) return;

    const sections = sectionsFor(result.value);
    const filed = sections.flatMap((section) => section.checks.map((check) => check.name));

    expect(filed.sort()).toEqual(result.value.checks.map((check) => check.name).sort());
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

  it("tallies label-first, so there is no plural to get wrong", () => {
    const text = formatDoctor({ doctor: sample });

    expect(text).toContain("ok 1");
    expect(text).toContain("warning 1");
    expect(text).toContain("error 1");
  });

  it("shows every check's name and message", () => {
    const text = formatDoctor({ doctor: sample });

    for (const check of sample.checks) {
      expect(text, check.name).toContain(check.name);
      expect(text, check.message).toContain(check.message);
    }
  });
});
