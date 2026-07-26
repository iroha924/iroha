import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertRepository,
  listEventLogByRepository,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { outcomeForErrorCode, recordEvent, recordEventForRepository } from "./event-log.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const RANDOM = new CryptoRandomSource();
const REPOSITORY_ID = makeTypedId("repo", CLOCK, RANDOM);

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function seededDb(): Promise<Database> {
  const { dir, db } = await openMigratedTestDb("iroha-event-log-test-");
  cleanup = async () => {
    await closeDatabase(db);
    await removeTempDir(dir);
  };
  const inserted = await insertRepository(db, {
    id: REPOSITORY_ID,
    rootFingerprint: "fp-event-log",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  if (!inserted.ok) {
    throw new Error(`failed to seed repository: ${inserted.error.message}`);
  }
  return db;
}

describe("recordEvent", () => {
  it("appends a row with only the whitelisted fields", async () => {
    const db = await seededDb();

    await recordEvent(
      db,
      REPOSITORY_ID,
      { clock: CLOCK, random: RANDOM },
      {
        eventType: "mcp.tool_call",
        adapter: "create_checkpoint",
        durationMs: 12,
        outcome: "success",
      },
    );

    const rows = await listEventLogByRepository(db, REPOSITORY_ID);
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]).toMatchObject({
      eventType: "mcp.tool_call",
      adapter: "create_checkpoint",
      durationMs: 12,
      outcome: "success",
      errorCode: null,
      sessionId: null,
      turnId: null,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("discards a write error instead of surfacing it", async () => {
    const db = await seededDb();
    await closeDatabase(db);

    // A closed connection is the cheapest unwritable row. `insertEventLog`
    // returns an `err` rather than throwing, and `recordEvent` drops it — every
    // call site is on a path that must not fail because diagnostics did.
    await expect(
      recordEvent(
        db,
        REPOSITORY_ID,
        { clock: CLOCK, random: RANDOM },
        { eventType: "sync.canonical", outcome: "success" },
      ),
    ).resolves.toBeUndefined();
  });

  it("pages deterministically when every row shares one timestamp", async () => {
    const db = await seededDb();
    const deps = { clock: CLOCK, random: RANDOM };

    // A FixedClock gives every row one `occurred_at`, so without the `id`
    // tiebreaker which rows a LIMIT selects is arbitrary and can differ between
    // identical queries. The tie order is stable, not creation order — ULID
    // randomness is random bytes, so same-millisecond ids do not sort by age.
    for (const adapter of ["search", "get_context", "create_checkpoint"] as const) {
      await recordEvent(db, REPOSITORY_ID, deps, {
        eventType: "mcp.tool_call",
        adapter,
        outcome: "success",
      });
    }

    const first = await listEventLogByRepository(db, REPOSITORY_ID, 2);
    const second = await listEventLogByRepository(db, REPOSITORY_ID, 2);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toHaveLength(2);
    expect(first.value.map((row) => row.id)).toEqual(second.value.map((row) => row.id));
    const ids = first.value.map((row) => row.id);
    expect(ids).toEqual([...ids].sort().reverse());
  });
});

describe("outcomeForErrorCode", () => {
  it("treats a caller's mistake as a warning and a broken dependency as a failure", () => {
    expect(outcomeForErrorCode("NOT_FOUND")).toBe("warning");
    expect(outcomeForErrorCode("INVALID_SESSION_TOKEN")).toBe("warning");
    expect(outcomeForErrorCode("INVALID_INPUT")).toBe("warning");
    expect(outcomeForErrorCode("DB_UNAVAILABLE")).toBe("failure");
    expect(outcomeForErrorCode("INTERNAL_ERROR")).toBe("failure");
    expect(outcomeForErrorCode("FORGE_UNAVAILABLE")).toBe("failure");
  });
});

describe("recordEventForRepository", () => {
  it("is fail-open outside an initialized repository", async () => {
    const { dir, db } = await openMigratedTestDb("iroha-event-log-uninit-");
    cleanup = async () => {
      await closeDatabase(db);
      await removeTempDir(dir);
    };

    await expect(
      recordEventForRepository({
        cwd: dir,
        clock: CLOCK,
        random: RANDOM,
        eventType: "api.request",
        adapter: "GET /api/v1/overview",
        outcome: "success",
      }),
    ).resolves.toBeUndefined();
  });
});
