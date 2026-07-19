import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { insertRepository } from "./identity.js";
import {
  deleteExpiredIdempotencyRecords,
  getIdempotencyRecord,
  getLocalSetting,
  getSyncCursor,
  insertDirtyMarker,
  insertEventLog,
  insertIdempotencyRecord,
  listEventLogByRepository,
  listOpenDirtyMarkers,
  resolveDirtyMarker,
  upsertLocalSetting,
  upsertSyncCursor,
} from "./operations.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}
function dirtyId(suffix: string): TypedId<"dirty"> {
  return `dirty_${suffix.padEnd(24, "0")}` as TypedId<"dirty">;
}
function logId(suffix: string): TypedId<"log"> {
  return `log_${suffix.padEnd(26, "0")}` as TypedId<"log">;
}

async function seedRepository(db: Database, suffix: string): Promise<TypedId<"repo">> {
  const id = repoId(suffix);
  await insertRepository(db, {
    id,
    rootFingerprint: `fp-${suffix}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

describe("operations repositories", () => {
  let tempDir: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    if (db) {
      closeDatabase(db);
      db = undefined;
    }
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("upserts a sync cursor, updating it in place on a second call", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "a");

    await upsertSyncCursor(db, {
      repositoryId,
      provider: "github",
      cursor: "c1",
      lastAttemptAt: NOW,
    });
    await upsertSyncCursor(db, {
      repositoryId,
      provider: "github",
      cursor: "c2",
      lastSuccessAt: LATER,
      lastAttemptAt: LATER,
    });

    const read = await getSyncCursor(db, repositoryId, "github");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.cursor).toBe("c2");
      expect(read.value?.lastSuccessAt).toBe(LATER);
    }
  });

  it("inserts a dirty marker, lists it as open, and resolves it", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "b");
    const id = dirtyId("b1");

    await insertDirtyMarker(db, {
      id,
      repositoryId,
      markerType: "sync_required",
      detailsJson: "{}",
      createdAt: NOW,
    });

    const open = await listOpenDirtyMarkers(db, repositoryId);
    expect(open.ok).toBe(true);
    if (open.ok) {
      expect(open.value.map((m) => m.id)).toEqual([id]);
      expect(open.value[0]?.resolvedAt).toBeNull();
    }

    await resolveDirtyMarker(db, id, LATER);

    const openAfter = await listOpenDirtyMarkers(db, repositoryId);
    expect(openAfter.ok).toBe(true);
    if (openAfter.ok) {
      expect(openAfter.value).toEqual([]);
    }
  });

  it("filters open dirty markers by marker type", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "c");
    await insertDirtyMarker(db, {
      id: dirtyId("c1"),
      repositoryId,
      markerType: "sync_required",
      detailsJson: "{}",
      createdAt: NOW,
    });
    await insertDirtyMarker(db, {
      id: dirtyId("c2"),
      repositoryId,
      markerType: "embedding_retry",
      detailsJson: "{}",
      createdAt: NOW,
    });

    const filtered = await listOpenDirtyMarkers(db, repositoryId, "embedding_retry");
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.value.map((m) => m.id)).toEqual([dirtyId("c2")]);
    }
  });

  it("upserts a local setting, updating it in place on a second call", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "d");

    await upsertLocalSetting(db, {
      repositoryId,
      key: "dashboard.theme",
      valueJson: '"light"',
      updatedAt: NOW,
    });
    await upsertLocalSetting(db, {
      repositoryId,
      key: "dashboard.theme",
      valueJson: '"dark"',
      updatedAt: LATER,
    });

    const read = await getLocalSetting(db, repositoryId, "dashboard.theme");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.valueJson).toBe('"dark"');
      expect(read.value?.updatedAt).toBe(LATER);
    }
  });

  it("inserts event log entries and lists them for a repository in occurred_at descending order", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "e");

    await insertEventLog(db, {
      id: logId("e1"),
      repositoryId,
      eventType: "hook.session_start",
      outcome: "success",
      occurredAt: NOW,
    });
    await insertEventLog(db, {
      id: logId("e2"),
      repositoryId,
      eventType: "hook.pre_tool_use",
      outcome: "denied",
      occurredAt: LATER,
    });

    const list = await listEventLogByRepository(db, repositoryId);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.map((e) => e.eventType)).toEqual([
        "hook.pre_tool_use",
        "hook.session_start",
      ]);
    }
  });

  it("records an idempotency result once and returns CONFLICT on a duplicate insert", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "f");

    const first = await insertIdempotencyRecord(db, {
      repositoryId,
      operation: "create_checkpoint",
      idempotencyKey: "idem-key-0123456789",
      responseJson: '{"ok":true}',
      createdAt: NOW,
      expiresAt: LATER,
    });
    expect(first.ok).toBe(true);

    const second = await insertIdempotencyRecord(db, {
      repositoryId,
      operation: "create_checkpoint",
      idempotencyKey: "idem-key-0123456789",
      responseJson: '{"ok":true,"different":true}',
      createdAt: NOW,
      expiresAt: LATER,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }

    const read = await getIdempotencyRecord(
      db,
      repositoryId,
      "create_checkpoint",
      "idem-key-0123456789",
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.responseJson).toBe('{"ok":true}');
    }
  });

  it("deletes expired idempotency records but keeps unexpired ones", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "g");

    await insertIdempotencyRecord(db, {
      repositoryId,
      operation: "create_checkpoint",
      idempotencyKey: "idem-key-expired-0000",
      responseJson: "{}",
      createdAt: NOW,
      expiresAt: NOW,
    });
    await insertIdempotencyRecord(db, {
      repositoryId,
      operation: "create_checkpoint",
      idempotencyKey: "idem-key-active-00000",
      responseJson: "{}",
      createdAt: NOW,
      expiresAt: "2027-01-01T00:00:00.000Z",
    });

    const deleted = await deleteExpiredIdempotencyRecords(db, LATER);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.value).toBe(1);
    }

    const expiredRead = await getIdempotencyRecord(
      db,
      repositoryId,
      "create_checkpoint",
      "idem-key-expired-0000",
    );
    expect(expiredRead.ok).toBe(true);
    if (expiredRead.ok) {
      expect(expiredRead.value).toBeNull();
    }
    const activeRead = await getIdempotencyRecord(
      db,
      repositoryId,
      "create_checkpoint",
      "idem-key-active-00000",
    );
    expect(activeRead.ok).toBe(true);
    if (activeRead.ok) {
      expect(activeRead.value).not.toBeNull();
    }
  });
});
