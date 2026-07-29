import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points `os.homedir()` at a fresh temp directory for the duration of a test, so
 * anything reading or writing `~/.iroha/credentials.json` cannot reach the real
 * one. A test that overwrote a developer's actual API key would be a defect no
 * assertion could catch.
 *
 * Both variables are set because `os.homedir()` reads `$HOME` on POSIX and
 * `%USERPROFILE%` on Windows.
 */
export async function useTempHome(): Promise<{ home: string; restore: () => Promise<void> }> {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = await mkdtemp(join(tmpdir(), "iroha-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
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
