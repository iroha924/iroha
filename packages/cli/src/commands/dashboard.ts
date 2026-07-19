import { define } from "gunshi";

/**
 * `@iroha/api`/`apps/dashboard` (WP-09) do not exist yet, so this shell only
 * reports that fact — implementation-plan.md WP-05's deliverable list calls
 * `dashboard` a "shell" alongside `init`/`sync`/`doctor`/`search`.
 */
export const dashboardCommand = define({
  name: "dashboard",
  description: "Launch the local dashboard (not yet implemented)",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
  },
  run: (ctx) => {
    const message = "iroha dashboard is not yet implemented (planned for WP-09).";
    if (ctx.values.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  },
});
