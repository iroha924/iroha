/**
 * Local end-to-end release smoke test (`pnpm release:smoke`).
 *
 * Publishes the exact `@irohalabs/iroha` artifact `release.yml` would ship to a
 * throwaway Verdaccio registry, installs it globally into a clean prefix, and
 * runs the CLI against a fresh git repo. This exercises the real publish →
 * `npm install -g` → run path (native `@libsql/client`, bin resolution, bundled
 * runtime assets) that the in-tree `test:package` cannot: it never leaves the
 * workspace. Requires network (Verdaccio proxies dependencies to npmjs).
 */
import { $, chalk, fs, os, path } from "zx";

const PORT = 4873;
const REGISTRY = `http://localhost:${PORT}/`;
$.verbose = true;

const work = await fs.mkdtemp(path.join(os.tmpdir(), "iroha-release-smoke-"));
const storage = path.join(work, "storage");
const configPath = path.join(work, "verdaccio.yaml");
const npmrc = path.join(work, "npmrc");
const prefix = path.join(work, "global");
const repo = path.join(work, "repo");
const releaseDir = path.join(process.cwd(), "packages", "plugin", "release");

/** Anonymous publish for our own scope; proxy everything else to npmjs. */
const VERDACCIO_CONFIG = `storage: ${storage}
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@irohalabs/*':
    access: $all
    publish: $anonymous
    unpublish: $anonymous
  '**':
    access: $all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
`;

async function waitForRegistry(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${REGISTRY}-/ping`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Verdaccio did not become ready on ${REGISTRY} within ${timeoutMs}ms`);
}

let verdaccio;
try {
  console.log(chalk.bold("\n1/5 Building the release artifact…"));
  await $`pnpm build`;
  await $`pnpm --filter @iroha/plugin build:release`;
  if (!(await fs.pathExists(path.join(releaseDir, "package.json")))) {
    throw new Error(`release artifact not found at ${releaseDir}`);
  }

  console.log(chalk.bold("\n2/5 Starting a throwaway Verdaccio registry…"));
  await fs.writeFile(configPath, VERDACCIO_CONFIG);
  await fs.writeFile(
    npmrc,
    `registry=${REGISTRY}\n//localhost:${PORT}/:_authToken=release-smoke\n`,
  );
  verdaccio = $`verdaccio --config ${configPath} --listen ${PORT}`.nothrow();
  await waitForRegistry();

  console.log(chalk.bold("\n3/5 Publishing @irohalabs/iroha to Verdaccio…"));
  await $({ cwd: releaseDir })`npm publish --userconfig ${npmrc} --registry ${REGISTRY}`;

  console.log(chalk.bold("\n4/5 Installing it globally into a clean prefix…"));
  await $`npm install -g @irohalabs/iroha --prefix ${prefix} --userconfig ${npmrc} --registry ${REGISTRY}`;
  const bin = path.join(prefix, "bin", "iroha");

  console.log(chalk.bold("\n5/5 Running the installed CLI against a fresh repo…"));
  await fs.ensureDir(repo);
  await $({ cwd: repo })`git init --initial-branch=main`;
  await $({ cwd: repo })`git config user.email smoke@example.com`;
  await $({ cwd: repo })`git config user.name smoke`;
  const version = (await $`${bin} --version`).stdout.trim();
  const init = JSON.parse((await $({ cwd: repo })`${bin} init --json`).stdout);
  if (init.ok !== true) throw new Error(`iroha init did not report ok: ${JSON.stringify(init)}`);
  const doctor = JSON.parse((await $({ cwd: repo })`${bin} doctor --json`).stdout);
  const initCheck = doctor.doctor?.checks?.find((c) => c.name === "iroha-init");
  if (initCheck?.status !== "ok") {
    throw new Error(`iroha doctor iroha-init check not ok: ${JSON.stringify(initCheck)}`);
  }

  console.log(
    chalk.green.bold(`\n✓ Release smoke passed — iroha ${version} publishes, installs, and runs.`),
  );
} finally {
  if (verdaccio) await verdaccio.kill().catch(() => {});
  await fs.remove(work).catch(() => {});
}
