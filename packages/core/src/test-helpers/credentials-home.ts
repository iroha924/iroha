import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points the credentials directory at a fresh temp home for the duration of a
 * test, so anything reading or writing it cannot reach the developer's real one.
 * A test that overwrote an actual API key would be a defect no assertion could
 * catch.
 *
 * All three variables matter: `os.homedir()` reads `$HOME` on POSIX and
 * `%USERPROFILE%` on Windows, and `credentialsLocation()` prefers
 * `$XDG_CONFIG_HOME` over both — a developer who has that set would otherwise
 * keep hitting their real file with `$HOME` moved.
 */
const REDIRECTED = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;

export async function useTempHome(): Promise<{ home: string; restore: () => Promise<void> }> {
  const previous = Object.fromEntries(REDIRECTED.map((key) => [key, process.env[key]]));
  const home = await mkdtemp(join(tmpdir(), "iroha-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  return {
    home,
    restore: async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}
