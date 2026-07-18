import { describe, expect, it } from "vitest";
import { redactUrlLikeCredentials } from "./credential-redaction.js";

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
