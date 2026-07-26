import { type DoctorReport, runDoctor } from "@iroha/core";
import { define } from "gunshi";
import { printError, printSuccess } from "../output.js";
import {
  accent,
  caution,
  danger,
  labelColumn,
  muted,
  row,
  sectionLabel,
  spread,
  statusGlyph,
  title,
} from "../render.js";

/**
 * Which section each check belongs to. The report carries no grouping, so the
 * presentation owns it — and an unmapped name must still be shown (`OTHER`),
 * because a check silently missing from `doctor` is worse than one filed oddly.
 * `doctor-sections.test.ts` asserts every name the report can emit is mapped.
 */
const SECTIONS: readonly { label: string; checks: readonly string[] }[] = [
  { label: "Environment", checks: ["node", "git", "claude", "codex"] },
  { label: "Integration", checks: ["mcp-server", "plugin-manifests"] },
  { label: "Repository", checks: ["git-repository", "iroha-init", "config"] },
  {
    label: "Index",
    checks: [
      "storage-capabilities",
      "guardrails",
      "embedding-provider",
      "forge-provider",
      "retention",
    ],
  },
];

const SECTIONED = new Set(SECTIONS.flatMap((section) => section.checks));

export function sectionsFor(
  report: DoctorReport,
): { label: string; checks: DoctorReport["checks"] }[] {
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  const grouped = SECTIONS.map((section) => ({
    label: section.label,
    checks: section.checks.flatMap((name) => {
      const check = byName.get(name);
      return check === undefined ? [] : [check];
    }),
  })).filter((section) => section.checks.length > 0);

  const unmapped = report.checks.filter((check) => !SECTIONED.has(check.name));
  return unmapped.length > 0 ? [...grouped, { label: "Other", checks: unmapped }] : grouped;
}

function verdict(report: DoctorReport): string {
  const has = (status: string) => report.checks.some((check) => check.status === status);
  if (has("error") || has("blocked")) {
    return danger("action needed");
  }
  return has("warning") ? caution("warnings only") : accent("all clear");
}

/** `ok 12 · warning 1`, label-first so there is no plural to get wrong. */
function tally(report: DoctorReport): string {
  const counts = new Map<string, number>();
  for (const check of report.checks) {
    counts.set(check.status, (counts.get(check.status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => `${status} ${count}`).join(muted(" · "));
}

export function formatDoctor(data: { doctor: DoctorReport }): string {
  const sections = sectionsFor(data.doctor);
  const width = labelColumn(data.doctor.checks.map((check) => check.name));
  const blocks = sections.map((section) =>
    [
      sectionLabel(section.label),
      ...section.checks.map((check) =>
        row(statusGlyph(check.status), check.name, check.message, width),
      ),
    ].join("\n"),
  );
  return [
    title("iroha doctor"),
    "",
    blocks.join("\n\n"),
    "",
    spread(tally(data.doctor), verdict(data.doctor)),
  ].join("\n");
}

export const doctorCommand = define({
  name: "doctor",
  description: "Diagnose the local environment, Git repository, and database",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;

    const result = await runDoctor(process.cwd());
    if (!result.ok) {
      printError(json, result.error);
      return;
    }
    printSuccess(json, { doctor: result.value }, formatDoctor);

    const hasError = result.value.checks.some((check) => check.status === "error");
    if (hasError) {
      process.exitCode = 1;
    }
  },
});
