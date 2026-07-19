/** Structural, not `@iroha/domain`'s `IrohaError` — the CLI's only dependency is `@iroha/core` (compatibility.md §4). */
interface DisplayableError {
  code: string;
  message: string;
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
      `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
  process.exitCode = 1;
}
