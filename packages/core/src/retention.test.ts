import { FixedClock, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertAgentSession,
  insertEntity,
  insertEventLog,
  insertRepository,
  upsertLocalSetting,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRetention,
  RETENTION_SETTING_KEY,
  readRetentionSetting,
  readRetentionStatus,
  retentionCutoff,
} from "./retention.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const CLOCK = new FixedClock(NOW);
const REPO = "repo_00000000000000000000000000" as TypedId<"repo">;
const OLD = "2026-01-01T00:00:00.000Z";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function seededDb(): Promise<Database> {
  const { dir, db } = await openMigratedTestDb("iroha-retention-test-");
  cleanup = async () => {
    await closeDatabase(db);
    await removeTempDir(dir);
  };
  const inserted = await insertRepository(db, {
    id: REPO,
    rootFingerprint: "fp-retention",
    createdAt: OLD,
    updatedAt: OLD,
  });
  if (!inserted.ok) {
    throw new Error(`failed to seed repository: ${inserted.error.message}`);
  }
  return db;
}

async function seedAgedSession(db: Database, suffix: string): Promise<TypedId<"ses">> {
  const sessionId = `ses_${suffix.padEnd(26, "0")}` as TypedId<"ses">;
  await insertEntity(db, {
    id: sessionId,
    repositoryId: REPO,
    entityType: "session",
    title: "Session",
    status: "active",
    authority: 60,
    sourceKind: "hook",
    createdAt: OLD,
    updatedAt: OLD,
  });
  await insertAgentSession(db, {
    id: sessionId,
    repositoryId: REPO,
    platform: "claude_code",
    platformSessionId: `plat-${suffix}`,
    startedAt: OLD,
    lastSeenAt: OLD,
  });
  return sessionId;
}

async function storeSetting(db: Database, valueJson: string): Promise<void> {
  const stored = await upsertLocalSetting(db, {
    repositoryId: REPO,
    key: RETENTION_SETTING_KEY,
    valueJson,
    updatedAt: OLD,
  });
  if (!stored.ok) {
    throw new Error(`failed to store setting: ${stored.error.message}`);
  }
}

describe("retentionCutoff", () => {
  it("is null when retention is off", () => {
    expect(retentionCutoff({ days: null }, CLOCK)).toBeNull();
  });

  it("is the instant `days` before now", () => {
    expect(retentionCutoff({ days: 30 }, CLOCK)).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("readRetentionSetting", () => {
  it("reads an absent row as retention off", async () => {
    const db = await seededDb();
    const setting = await readRetentionSetting(db, REPO);
    expect(setting.ok && setting.value.setting).toEqual({ days: null });
    expect(setting.ok && setting.value.rawJson).toBeNull();
  });

  it("reads a stored window", async () => {
    const db = await seededDb();
    await storeSetting(db, JSON.stringify({ days: 90 }));
    const setting = await readRetentionSetting(db, REPO);
    expect(setting.ok && setting.value.setting).toEqual({ days: 90 });
    // The raw JSON comes out of the same read, so a sweep's guard and its cutoff
    // can never be derived from two different reads.
    expect(setting.ok && setting.value.rawJson).toBe(JSON.stringify({ days: 90 }));
  });

  it("rejects a stored value that is not valid JSON", async () => {
    const db = await seededDb();
    // `upsertLocalSetting` requires `json_valid`, so the corrupt case has to be
    // written past it — a JSON string is valid JSON but not a valid window.
    await storeSetting(db, '"90 days"');
    const setting = await readRetentionSetting(db, REPO);
    expect(setting.ok).toBe(false);
    if (setting.ok) return;
    expect(setting.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a window outside the accepted range instead of guessing", async () => {
    const db = await seededDb();
    // A value that governs deletion must not silently fall back to a default:
    // "keep everything" and "delete everything older than 0 days" are opposites.
    for (const bad of [{ days: 0 }, { days: -1 }, { days: 4000 }, { days: 1.5 }, {}]) {
      await storeSetting(db, JSON.stringify(bad));
      const setting = await readRetentionSetting(db, REPO);
      expect(setting.ok, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });
});

describe("applyRetention", () => {
  it("reports disabled and deletes nothing when no window is set", async () => {
    const db = await seededDb();
    await seedAgedSession(db, "keep");

    const outcome = await applyRetention(db, REPO, CLOCK);
    expect(outcome).toEqual({ status: "disabled", days: null });
    const status = await readRetentionStatus(db, REPO, CLOCK);
    expect(status.ok && status.value.counts.sessions).toBe(1);
  });

  it("prunes an aged session when a window is set", async () => {
    const db = await seededDb();
    await seedAgedSession(db, "prune");
    await storeSetting(db, JSON.stringify({ days: 30 }));

    const outcome = await applyRetention(db, REPO, CLOCK);
    expect(outcome.status).toBe("pruned");
    expect(outcome.days).toBe(30);
    expect(outcome.pruned?.sessions).toBe(1);
  });

  it("deletes nothing further once the window is turned off underneath it", async () => {
    const db = await seededDb();
    await seedAgedSession(db, "one");
    await seedAgedSession(db, "two");
    await storeSetting(db, JSON.stringify({ days: 30 }));
    const logged = await insertEventLog(db, {
      id: "log_00000000000000000000000001" as TypedId<"log">,
      repositoryId: REPO,
      eventType: "api.request",
      outcome: "failure",
      occurredAt: OLD,
    });
    expect(logged.ok).toBe(true);

    // Simulate the dashboard turning retention off while a sync is finishing: the
    // change lands after the candidate list was taken. `pruneSession` reads the
    // guard inside its own write transaction, so it declines; the sweep must then
    // also skip the diagnostics prune, which would otherwise still run with the
    // superseded cutoff.
    // `Database["execute"]` is overloaded, so its `Parameters` resolve to `never`.
    // Every caller in this package passes the `{sql, args}` form, so the spy is
    // typed to that shape rather than to the overload set.
    type Execute = (statement: { sql: string; args: unknown[] }) => Promise<unknown>;
    const target = db as unknown as { execute: Execute };
    const original = target.execute.bind(db);
    let changed = false;
    target.execute = async (statement) => {
      const result = await original(statement);
      if (!changed && statement.sql.includes("FROM agent_sessions s")) {
        changed = true;
        await original({
          sql: "UPDATE local_settings SET value_json = ? WHERE key = ?",
          args: [JSON.stringify({ days: null }), RETENTION_SETTING_KEY],
        });
      }
      return result;
    };

    const outcome = await applyRetention(db, REPO, CLOCK);
    target.execute = original;

    expect(outcome.status).toBe("pruned");
    expect(outcome.pruned).toEqual({ sessions: 0, checkpoints: 0, eventLogRows: 0 });
    const remaining = await readRetentionStatus(db, REPO, CLOCK);
    expect(remaining.ok).toBe(true);
    if (!remaining.ok) return;
    expect(remaining.value.counts.sessions).toBe(2);
    expect(remaining.value.counts.eventLogRows).toBe(1);
  });

  it("reports failed rather than throwing when the setting is unreadable", async () => {
    const db = await seededDb();
    await storeSetting(db, '"not a window"');

    // Retention runs at the end of `iroha sync`; a bad setting must surface as an
    // outcome, never as an error that fails the sync already completed.
    const outcome = await applyRetention(db, REPO, CLOCK);
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("INVALID_INPUT");
  });
});

describe("readRetentionStatus", () => {
  it("counts prunable sessions only once a window is set", async () => {
    const db = await seededDb();
    await seedAgedSession(db, "status");

    const off = await readRetentionStatus(db, REPO, CLOCK);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.days).toBeNull();
    expect(off.value.counts).toMatchObject({ sessions: 1, prunableSessions: 0 });

    await storeSetting(db, JSON.stringify({ days: 30 }));
    const on = await readRetentionStatus(db, REPO, CLOCK);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.value).toMatchObject({ days: 30 });
    expect(on.value.counts.prunableSessions).toBe(1);
  });
});
