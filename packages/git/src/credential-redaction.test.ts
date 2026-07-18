import { describe, expect, it } from "vitest";
import {
  redactAbsolutePathsInText,
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

  it("does not let an '@' inside the query string be mistaken for a userinfo boundary", () => {
    // No path segment before "?", so a userinfo match that doesn't stop at
    // "?" can cross it and backtrack onto the query value's own "@" —
    // mis-parsing part of the query as userinfo and the rest as the host.
    expect(redactUrlLikeCredentials("https://example.com?access_token=a@b")).toBe(
      "https://example.com",
    );
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

  it("redacts two URLs joined by a comma, with no whitespace between them", () => {
    // Git accepts (and can print back) a value like this; without a comma
    // boundary the whole thing matches as one URL, and the second URL's
    // credential is treated as part of the first URL's path/query and
    // survives redaction.
    const text = "https://safe.example/x,https://tok@evil.example/y";

    expect(redactUrlLikeCredentialsInText(text)).toBe(
      "https://safe.example/x,https://evil.example/y",
    );
  });

  it("redacts a credentialed URL whose password itself contains a comma", () => {
    // A comma/semicolon is a legal unencoded userinfo character (RFC 3986
    // sub-delims). Treating it as a hard text-delimiter (as an earlier
    // version of this module did) truncates the match before its "@" is
    // ever seen, so the credential is never recognized as one at all.
    const text = "https://user:p,ss@example.invalid/repo.git";

    expect(redactUrlLikeCredentialsInText(text)).toBe("https://example.invalid/repo.git");
  });

  it("still separates a comma-joined pair when the first URL's password has a comma", () => {
    const text = "https://user:p,ss@one.example/x,https://tok@two.example/y";

    expect(redactUrlLikeCredentialsInText(text)).toBe(
      "https://one.example/x,https://two.example/y",
    );
  });

  it("redacts a credentialed URL whose password contains a closing parenthesis", () => {
    // ")" is a valid unencoded RFC 3986 userinfo character, same category
    // as "," fixed above — HARD_DELIMITER still treats it as a boundary
    // (needed to correctly trim Git's own quoted-pathspec text elsewhere),
    // so this only works because the delimiter search now starts after the
    // userinfo has already been consumed via SCHEME_AND_USERINFO.
    const text = "https://user:p)ss@example.invalid/repo.git";

    expect(redactUrlLikeCredentialsInText(text)).toBe("https://example.invalid/repo.git");
  });

  it("redacts a credentialed URL whose password contains a single quote", () => {
    const text = "https://user:p'ss@example.invalid/repo.git";

    expect(redactUrlLikeCredentialsInText(text)).toBe("https://example.invalid/repo.git");
  });

  it("still trims a trailing quote from Git's own quoted pathspec text", () => {
    // Regression guard for the fix above: HARD_DELIMITER must still apply
    // to the host+path portion, just not to the userinfo portion.
    const text =
      "error: pathspec 'https://ghp_secrettoken@example.invalid/org/repo.git' did not match";

    expect(redactUrlLikeCredentialsInText(text)).toBe(
      "error: pathspec 'https://example.invalid/org/repo.git' did not match",
    );
  });
});

describe("redactAbsolutePathsInText", () => {
  it("redacts an absolute path Git embeds in its own diagnostic text", () => {
    // Confirmed by reproduction: a malformed GIT_CONFIG_GLOBAL file makes
    // Git print this exact shape, with no credential-URL marker for
    // redactUrlLikeCredentialsInText to find.
    const stderr = "fatal: bad config line 1 in file /tmp/xxx/.gitconfig";

    expect(redactAbsolutePathsInText(stderr)).toBe("fatal: bad config line 1 in file <path>");
  });

  it("leaves an already credential-redacted URL's own slashes untouched", () => {
    const text = "error: pathspec 'https://example.invalid/org/repo.git' did not match";

    expect(redactAbsolutePathsInText(text)).toBe(text);
  });

  it("leaves text with no absolute path unchanged", () => {
    const text = "fatal: not a git repository (or any of the parent directories): .git";

    expect(redactAbsolutePathsInText(text)).toBe(text);
  });

  it("redacts a path at the very start of the text", () => {
    // The whole run of non-whitespace/quote characters is consumed as part
    // of the path match, including a trailing punctuation character like
    // ":" — a minor cosmetic loss, not a correctness issue, given the goal
    // is eliminating the path text, not reformatting the surrounding prose.
    expect(redactAbsolutePathsInText("/etc/passwd: permission denied")).toBe(
      "<path> permission denied",
    );
  });
});
