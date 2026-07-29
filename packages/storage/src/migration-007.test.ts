import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedClock } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database, openDatabase } from "./connection.js";
import { runMigrations } from "./migrator.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";

const REAL_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const AT = "2026-07-20T00:00:00.000Z";

/** The migrations directory as it stood before 007, so a v6 database can be built. */
async function migrationsThroughV6(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iroha-migrations-v6-"));
  for (const entry of await readdir(REAL_MIGRATIONS_DIR)) {
    if (Number.parseInt(entry, 10) > 6) {
      continue;
    }
    await writeFile(
      join(dir, entry),
      await readFile(join(REAL_MIGRATIONS_DIR, entry), "utf8"),
      "utf8",
    );
  }
  return dir;
}

/** A candidate in the shape the removed `iroha init --scan` wrote. */
function docsScanPayload(path: string): string {
  return JSON.stringify({
    title: `Project instructions from ${path}`,
    body: "# Rule",
    source: { type: "document", path, content_hash: `sha256:${"0".repeat(64)}` },
    imported_at: AT,
    line_range: { start: 1, end: 1 },
    detected_scope: { paths: [] },
  });
}

/** A candidate in the shape `propose_knowledge` writes — no `detected_scope` anywhere. */
function proposalPayload(): string {
  return JSON.stringify({
    type: "rule",
    title: "Validate boundaries",
    summary: "Validate every external boundary.",
    body: "# Validate boundaries",
    labels: [],
    scope: { paths: [], symbols: [] },
    sources: [{ type: "url", ref: "https://example.com" }],
  });
}

describe("migration 007: drop imported-doc candidates", () => {
  let tempDirs: string[] = [];
  let dbs: Database[] = [];

  afterEach(async () => {
    for (const db of dbs) {
      await closeDatabase(db);
    }
    dbs = [];
    for (const dir of tempDirs) {
      await removeTempDir(dir);
    }
    tempDirs = [];
  });

  it("removes the pending docs-scan candidates and their hash settings, and nothing else", async () => {
    const v6Dir = await migrationsThroughV6();
    tempDirs.push(v6Dir);
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);
    const db = opened.value;

    const toV6 = await runMigrations(db, v6Dir, dbPath, CLOCK);
    expect(toV6.ok).toBe(true);

    await db.executeMultiple(`
      INSERT INTO repositories (id, vcs, root_fingerprint, created_at, updated_at)
        VALUES ('repo_1', 'git', 'fp_1', '${AT}', '${AT}');
      INSERT INTO local_settings (repository_id, key, value_json, updated_at)
        VALUES ('repo_1', 'docs_scan:CLAUDE.md', '{"hash":"sha256:x"}', '${AT}'),
               ('repo_1', 'retention.local_events', '{"days":30}', '${AT}');
    `);
    for (const [id, status, payload] of [
      ["cand_pending_scan", "pending", docsScanPayload("CLAUDE.md")],
      ["cand_approved_scan", "approved", docsScanPayload("AGENTS.md")],
      ["cand_pending_proposal", "pending", proposalPayload()],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO candidates (id, repository_id, candidate_type, payload_json, status, revision_token, created_at)
              VALUES (?, 'repo_1', 'rule', ?, ?, 'tok', ?)`,
        args: [id, payload, status, AT],
      });
    }

    const migrated = await runMigrations(db, REAL_MIGRATIONS_DIR, dbPath, CLOCK);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.value.map((m) => m.version)).toEqual([7]);
    }

    const candidates = await db.execute("SELECT id FROM candidates ORDER BY id");
    // The approved one keeps its decision record; a real proposal is untouched
    // because `proposalSchema` is a strictObject that could never carry
    // `detected_scope`, which is what makes the key a safe discriminator.
    expect(candidates.rows.map((r) => r.id)).toEqual([
      "cand_approved_scan",
      "cand_pending_proposal",
    ]);

    const settings = await db.execute("SELECT key FROM local_settings ORDER BY key");
    expect(settings.rows.map((r) => r.key)).toEqual(["retention.local_events"]);

    const userVersion = await db.execute("PRAGMA user_version");
    expect(userVersion.rows[0]?.user_version).toBe(7);
  });
});
