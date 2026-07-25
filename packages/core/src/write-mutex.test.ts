import { describe, expect, it } from "vitest";
import { withRepositoryWriteLock } from "./write-mutex.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

describe("withRepositoryWriteLock", () => {
  it("serializes critical sections for the same repository", async () => {
    const started: string[] = [];
    const a = gate();
    const pA = withRepositoryWriteLock("repo-1", async () => {
      started.push("A");
      await a.held;
    });
    const pB = withRepositoryWriteLock("repo-1", async () => {
      started.push("B");
    });

    await tick();
    // B is queued behind A's still-running section, so it has not started.
    expect(started).toStrictEqual(["A"]);

    a.release();
    await Promise.all([pA, pB]);
    expect(started).toStrictEqual(["A", "B"]);
  });

  it("does not serialize across different repositories", async () => {
    const started: string[] = [];
    const a = gate();
    const pA = withRepositoryWriteLock("repo-1", async () => {
      started.push("A");
      await a.held;
    });
    const pB = withRepositoryWriteLock("repo-2", async () => {
      started.push("B");
    });

    await tick();
    // Different repository → B runs even while A is still holding its own lock.
    expect(started).toStrictEqual(["A", "B"]);

    a.release();
    await Promise.all([pA, pB]);
  });

  it("does not let a rejected section poison the lock for the next", async () => {
    await expect(
      withRepositoryWriteLock("repo-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const result = await withRepositoryWriteLock("repo-1", async () => "ok");
    expect(result).toBe("ok");
  });

  it("returns the section's resolved value", async () => {
    expect(await withRepositoryWriteLock("repo-1", async () => 42)).toBe(42);
  });
});
