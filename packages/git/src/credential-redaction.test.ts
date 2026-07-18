import { describe, expect, it } from "vitest";
import {
  redactUrlLikeCredentials,
  redactUrlLikeCredentialsInText,
} from "./credential-redaction.js";

describe("redactUrlLikeCredentials", () => {
  it("strips a token used as the https username", () => {
    expect(redactUrlLikeCredentials("https://ghp_abc123token@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("strips a user:password pair from an https URL", () => {
    expect(redactUrlLikeCredentials("https://alice:hunter2@example.com/org/repo.git")).toBe(
      "https://example.com/org/repo.git",
    );
  });

  it("strips a query-string token", () => {
    expect(redactUrlLikeCredentials("https://github.com/org/repo.git?access_token=SECRET")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("strips a fragment carrying a token", () => {
    expect(redactUrlLikeCredentials("https://example.com/repo.git#token=SECRET")).toBe(
      "https://example.com/repo.git",
    );
  });

  it("strips userinfo and query together", () => {
    expect(redactUrlLikeCredentials("https://token@example.com/repo.git?sig=SECRET")).toBe(
      "https://example.com/repo.git",
    );
  });

  it("strips a password containing an unescaped @ entirely", () => {
    expect(redactUrlLikeCredentials("https://alice:p@ss@example.com/org/repo.git")).toBe(
      "https://example.com/org/repo.git",
    );
  });

  it("leaves a credential-free https URL unchanged", () => {
    expect(redactUrlLikeCredentials("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("leaves an SCP-like SSH remote unchanged", () => {
    expect(redactUrlLikeCredentials("git@github.com:org/repo.git")).toBe(
      "git@github.com:org/repo.git",
    );
  });

  it("leaves a non-URL argument unchanged", () => {
    expect(redactUrlLikeCredentials("--format=%H")).toBe("--format=%H");
  });

  it("leaves a Windows drive-letter local path unchanged", () => {
    expect(redactUrlLikeCredentials("C:\\Users\\dev\\repo.git")).toBe("C:\\Users\\dev\\repo.git");
  });
});

describe("redactUrlLikeCredentialsInText", () => {
  it("redacts a credentialed URL embedded in a larger sentence", () => {
    const stderr =
      "error: pathspec 'https://ghp_secrettoken@example.invalid/org/repo.git' did not match any file(s) known to git";

    expect(redactUrlLikeCredentialsInText(stderr)).toBe(
      "error: pathspec 'https://example.invalid/org/repo.git' did not match any file(s) known to git",
    );
  });

  it("redacts multiple embedded URLs", () => {
    const text = "tried https://a@one.example/x then https://b@two.example/y";

    expect(redactUrlLikeCredentialsInText(text)).toBe(
      "tried https://one.example/x then https://two.example/y",
    );
  });

  it("leaves text with no embedded URL unchanged", () => {
    const text = "fatal: not a git repository (or any of the parent directories): .git";

    expect(redactUrlLikeCredentialsInText(text)).toBe(text);
  });
});
