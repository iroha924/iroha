import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertRepository,
  listEventLogByRepository,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { recordEvent, recordEventForRepository } from "./event-log.js";
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
        eventType: "hook.tool_started",
        adapter: "claude_code",
        durationMs: 12,
        outcome: "success",
      },
    );

    const rows = await listEventLogByRepository(db, REPOSITORY_ID);
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]).toMatchObject({
      eventType: "hook.tool_started",
      adapter: "claude_code",
      durationMs: 12,
      outcome: "success",
      errorCode: null,
      sessionId: null,
      turnId: null,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("records a denial with the denying rule id as the error code", async () => {
    const db = await seededDb();

    await recordEvent(
      db,
      REPOSITORY_ID,
      { clock: CLOCK, random: RANDOM },
      {
        eventType: "guardrail.denied",
        adapter: "codex",
        outcome: "denied",
        errorCode: "kno_01JQZ0000000000000000000",
      },
    );

    const rows = await listEventLogByRepository(db, REPOSITORY_ID);
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.value[0]?.outcome).toBe("denied");
    expect(rows.value[0]?.errorCode).toBe("kno_01JQZ0000000000000000000");
  });

  it("is fail-open when the write cannot happen", async () => {
    const db = await seededDb();
    await closeDatabase(db);

    // A closed connection is the cheapest reproduction of an unwritable row; the
    // caller must not learn about it, since every call site is on a fail-open path.
    await expect(
      recordEvent(
        db,
        REPOSITORY_ID,
        { clock: CLOCK, random: RANDOM },
        {
          eventType: "sync.canonical",
          outcome: "success",
        },
      ),
    ).resolves.toBeUndefined();
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
