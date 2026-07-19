import { type DoctorReport, runDoctor } from "@iroha/core";
import { define } from "gunshi";
import { newRandom } from "../context.js";
import { printError, printSuccess } from "../output.js";

const STATUS_ICON: Record<string, string> = {
  ok: "[ok]",
  warning: "[warn]",
  error: "[error]",
  blocked: "[blocked]",
};

function formatDoctor(data: { doctor: DoctorReport }): string {
  return data.doctor.checks
    .map((check) => `${STATUS_ICON[check.status] ?? "[?]"} ${check.name}: ${check.message}`)
    .join("\n");
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
    const cwd = process.cwd();

    const result = await runDoctor(cwd, newRandom());
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
