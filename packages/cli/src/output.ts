/** Structural, not `@iroha/domain`'s `IrohaError` — the CLI's only dependency is `@iroha/core` (compatibility.md §4). */
interface DisplayableError {
  code: string;
  message: string;
  /**
   * Structured, already-redacted context (`IrohaError.details`). Safe to display:
   * per `.claude/rules/secure-subprocess-and-credentials.md` `details` is scrubbed
   * of raw paths/args/credentials at construction time, not here. `cause` is never
   * surfaced — a raw exception there can carry a full invoked command.
   */
  details?: Record<string, unknown> | undefined;
}

export function printSuccess<T extends object>(
  json: boolean,
  data: T,
  formatText: (data: T) => string,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...data }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatText(data)}\n`);
  }
}

export function printError(json: boolean, error: DisplayableError): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    if (error.details !== undefined) {
      process.stderr.write(`Details: ${JSON.stringify(error.details)}\n`);
    }
  }
  process.exitCode = 1;
}
