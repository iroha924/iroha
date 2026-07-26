import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { RETENTION_SETTING_KEY } from "../retention.js";
import { type McpTestRepo, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { getSettings, updateLocalSettings } from "./settings.js";

const clock = new FixedClock(new Date("2026-07-01T00:00:00.000Z"));
const random = new CryptoRandomSource();

describe("local retention setting", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("reports retention as off before anything is set", async () => {
    repo = await setupMcpRepo(random);
    const settings = await getSettings({ cwd: repo.repoDir, clock, random });
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    expect(settings.value.local.retentionDays).toBeNull();
  });

  it("stores a window and reads it back", async () => {
    repo = await setupMcpRepo(random);
    const updated = await updateLocalSettings({
      cwd: repo.repoDir,
      clock,
      random,
      key: RETENTION_SETTING_KEY,
      value: { days: 90 },
    });
    expect(updated.ok).toBe(true);

    const settings = await getSettings({ cwd: repo.repoDir, clock, random });
    expect(settings.ok && settings.value.local.retentionDays).toBe(90);
  });

  it("accepts an explicit null to turn retention back off", async () => {
    repo = await setupMcpRepo(random);
    for (const value of [{ days: 30 }, { days: null }]) {
      const updated = await updateLocalSettings({
        cwd: repo.repoDir,
        clock,
        random,
        key: RETENTION_SETTING_KEY,
        value,
      });
      expect(updated.ok, `expected ${JSON.stringify(value)} to be accepted`).toBe(true);
    }
    const settings = await getSettings({ cwd: repo.repoDir, clock, random });
    expect(settings.ok && settings.value.local.retentionDays).toBeNull();
  });

  it("rejects a malformed window at the write boundary", async () => {
    repo = await setupMcpRepo(random);
    // The API accepts any `(key, value)` pair, so without this check a malformed
    // window would be stored and only rejected later, when it is read to decide
    // what to delete — leaving `iroha sync` reporting a retention failure every
    // run with nothing pruned.
    for (const value of [{ days: 0 }, { days: -5 }, { days: 4000 }, { days: 1.5 }, "90", {}]) {
      const updated = await updateLocalSettings({
        cwd: repo.repoDir,
        clock,
        random,
        key: RETENTION_SETTING_KEY,
        value,
      });
      expect(updated.ok, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
      if (updated.ok) continue;
      expect(updated.error.code).toBe("INVALID_INPUT");
    }
    const settings = await getSettings({ cwd: repo.repoDir, clock, random });
    expect(settings.ok && settings.value.local.retentionDays).toBeNull();
  });

  it("leaves an unrelated local key unvalidated", async () => {
    repo = await setupMcpRepo(random);
    // Only known keys are schema-checked; the table stays a general key-value
    // store, so an unrelated key must not start failing.
    const updated = await updateLocalSettings({
      cwd: repo.repoDir,
      clock,
      random,
      key: "some.other.setting",
      value: { anything: true },
    });
    expect(updated.ok).toBe(true);
  });
});
