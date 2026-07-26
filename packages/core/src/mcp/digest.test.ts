import { CryptoRandomSource, FixedClock, type TypedId } from "@iroha/domain";
import { closeDatabase, type Database, insertToolEvent, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { getDigest } from "../dashboard/digest.js";
import { type McpTestRepo, seedSessionWithToken, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpGetDigestData, mcpSaveDigestProse } from "./digest.js";

/** Inside the ISO week starting Monday 2026-07-20, in UTC. */
const NOW = "2026-07-23T12:00:00.000Z";
const IN_WINDOW = "2026-07-22T09:00:00.000Z";

const clock = new FixedClock(new Date(NOW));
const random = new CryptoRandomSource();

const ORIGINAL_TZ = process.env.TZ;

/**
 * A shape the shared scanner flags (secretlint's `basicauth` rule) using the
 * short obviously-fake token the repository already commits elsewhere. A
 * realistic 36-character `ghp_` token would also be flagged, but trips the
 * pre-commit gitleaks scan, which cannot tell a fixture from a leak.
 */
const CREDENTIALED_URL = "https://user:ghp_secrettoken@github.com/x/y.git";

async function openRepoDb(repo: McpTestRepo): Promise<Database> {
  const opened = await openDatabase(repo.dbPath);
  if (!opened.ok) throw new Error(`db open failed: ${opened.error.message}`);
  return opened.value;
}

/** A session with a live token, plus a turn to hang denied tool events on. */
async function seedSession(repo: McpTestRepo): Promise<{ token: string; turnId: TypedId<"trn"> }> {
  const db = await openRepoDb(repo);
  try {
    const seeded = await seedSessionWithToken(db, repo, clock, random);
    return { token: seeded.token, turnId: seeded.turnId };
  } finally {
    await closeDatabase(db);
  }
}

async function seedDenial(
  db: Database,
  suffix: string,
  turnId: TypedId<"trn">,
  path: string,
): Promise<void> {
  const inserted = await insertToolEvent(db, {
    id: `evt_${suffix.padEnd(26, "0")}` as TypedId<"evt">,
    turnId,
    toolName: "Write",
    phase: "denied",
    status: "denied",
    targetKind: "file",
    targetSummary: path,
    occurredAt: IN_WINDOW,
  });
  if (!inserted.ok) throw new Error(`seed denial failed: ${inserted.error.message}`);
}

function proseWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headline: "A quiet week",
    standfirst: "Nothing broke.",
    sections: [{ slot: "wins", heading: "Held", body: "The rules held." }],
    ...overrides,
  };
}

describe("mcpGetDigestData", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it("returns the period's facts with no session token required", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);

    const data = await mcpGetDigestData({ cwd: repo.repoDir, clock, random });

    expect(data.ok).toBe(true);
    if (!data.ok) return;
    expect(data.value.period.key).toBe("2026-07-20");
    expect(data.value.facts.map((fact) => fact.id)).toContain("local.denials.total");
  });

  it("hands the agent no actor, author, or session-owner field", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    await seedSession(repo);

    const data = await mcpGetDigestData({ cwd: repo.repoDir, clock, random });

    expect(data.ok).toBe(true);
    if (!data.ok) return;
    // Structural, not procedural: the composing agent cannot narrate per-person
    // because the person data is not in what it receives.
    const serialized = JSON.stringify(data.value).toLowerCase();
    for (const forbidden of ["actor", "author", "email", "owner", "user"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("mcpSaveDigestProse", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it("stores prose and renders it with iroha's own numbers", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const { token, turnId } = await seedSession(repo);
    const db = await openRepoDb(repo);
    try {
      await seedDenial(db, "d1", turnId, "packages/git/a.ts");
      await seedDenial(db, "d2", turnId, "packages/git/b.ts");
    } finally {
      await closeDatabase(db);
    }

    const saved = await mcpSaveDigestProse({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: token,
      prose: proseWith({
        headline: "{{local.denials.total}} edits the Guardrails caught",
        sections: [
          {
            slot: "stumbles",
            heading: "Where it stopped",
            body: "The hook denied {{local.denials.total}} writes.",
          },
        ],
      }),
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.period.key).toBe("2026-07-20");
    expect(saved.value.composedAt).toBe(NOW);

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    // The agent wrote references; the renderer supplied the values, so the page
    // shows iroha's count and never one the agent could have chosen.
    expect(digest.value.prose?.prose.headline).toBe("2 edits the Guardrails caught");
    expect(digest.value.prose?.prose.sections[0]?.body).toBe("The hook denied 2 writes.");
    expect(digest.value.prose?.unreviewed).toBe(true);
  });

  it("refuses a request with no valid session token", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    await seedSession(repo);

    const saved = await mcpSaveDigestProse({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: "ist_notarealtokenatallnotarealtokenatallxxxxx",
      prose: proseWith(),
    });

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(["INVALID_SESSION_TOKEN", "SESSION_EXPIRED"]).toContain(saved.error.code);
    const digest = await getDigest({ cwd: repo.repoDir, clock, random });
    expect(digest.ok && digest.value.prose).toBeNull();
  });

  it("refuses prose that cites a fact this period never issued", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const { token } = await seedSession(repo);

    const saved = await mcpSaveDigestProse({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: token,
      prose: proseWith({ headline: "Velocity is up {{local.velocity.score}}%" }),
    });

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error.code).toBe("INVALID_INPUT");
    expect(saved.error.details).toEqual({ unknownFactIds: ["local.velocity.score"] });
  });

  it("refuses prose whose shape does not match, without touching the store", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const { token } = await seedSession(repo);

    const saved = await mcpSaveDigestProse({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: token,
      prose: { headline: "no sections" },
    });

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error.code).toBe("INVALID_INPUT");
    const digest = await getDigest({ cwd: repo.repoDir, clock, random });
    expect(digest.ok && digest.value.prose).toBeNull();
  });

  it("redacts a secret before the prose reaches the database", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const { token } = await seedSession(repo);

    const saved = await mcpSaveDigestProse({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: token,
      prose: proseWith({
        sections: [
          {
            slot: "teaching",
            heading: "h",
            body: `Never paste ${CREDENTIALED_URL} into a branch note.`,
          },
        ],
      }),
    });
    expect(saved.ok).toBe(true);

    const db = await openRepoDb(repo);
    try {
      const rows = await db.execute("SELECT prose_json FROM digest_issues");
      expect(String(rows.rows[0]?.prose_json)).not.toContain("ghp_");
    } finally {
      await closeDatabase(db);
    }
  });

  it("overwrites the previous issue when a period is recomposed", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const { token } = await seedSession(repo);
    const repoDir = repo.repoDir;
    const compose = (headline: string) =>
      mcpSaveDigestProse({
        cwd: repoDir,
        clock,
        random,
        sessionToken: token,
        prose: proseWith({ headline }),
      });

    expect((await compose("First draft")).ok).toBe(true);
    expect((await compose("Second draft")).ok).toBe(true);

    const digest = await getDigest({ cwd: repoDir, clock, random });
    expect(digest.ok && digest.value.prose?.prose.headline).toBe("Second draft");
    const db = await openRepoDb(repo);
    try {
      const rows = await db.execute("SELECT COUNT(*) AS c FROM digest_issues");
      expect(Number(rows.rows[0]?.c)).toBe(1);
    } finally {
      await closeDatabase(db);
    }
  });

  it("keeps a back issue's prose separate from the current period's", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const { token } = await seedSession(repo);

    await mcpSaveDigestProse({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: token,
      offset: 1,
      prose: proseWith({ headline: "Last week" }),
    });

    const current = await getDigest({ cwd: repo.repoDir, clock, random });
    const back = await getDigest({ cwd: repo.repoDir, clock, random, offset: 1 });

    expect(current.ok && current.value.prose).toBeNull();
    expect(back.ok && back.value.prose?.prose.headline).toBe("Last week");
  });
});
