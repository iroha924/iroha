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

  it("drops a secret entirely rather than re-emitting it as a nested URL", () => {
    // Confirmed by reproduction of the underlying shape: a scheme:// URL
    // embedded in another URL's query value. redactUrlLikeCredentials
    // already drops the whole query (it can't tell a "secret" apart from
    // an ordinary query value), so the fix here is that the loop must not
    // treat the nested scheme as an independent second candidate and
    // append its (unredacted, since it has no userinfo of its own) text
    // back into the result — which is exactly how the secret leaked back
    // in before this fix.
    const text = "https://github.com/org/repo.git?access_token=https://example.com/SECRET";

    expect(redactUrlLikeCredentialsInText(text)).toBe("https://github.com/org/repo.git");
  });

  it("drops a nested URL from a fragment the same way as from a query", () => {
    const text = "https://github.com/org/repo.git#token=https://example.com/SECRET";

    expect(redactUrlLikeCredentialsInText(text)).toBe("https://github.com/org/repo.git");
  });

  it("swallows a genuinely separate URL that follows one with its own query", () => {
    // Superseded expectation: an earlier version of this function bounded a
    // query by whitespace, correctly preserving a second, unrelated URL
    // that came after one with a query. Confirmed by reproduction that a
    // query value can itself contain a raw, unencoded space (see the
    // dedicated test below) — so whitespace cannot safely bound a query
    // either, and there is no character-based way to tell "the query ended
    // and unrelated text follows" apart from "the query itself contains a
    // space". Losing the second URL here is the accepted cost of never
    // leaking part of an opaque query value.
    const text = "tried https://a.example/x?tok=1 then https://tok@b.example/y";

    expect(redactUrlLikeCredentialsInText(text)).toBe("tried https://a.example/x");
  });

  it("drops a query value containing a HARD_DELIMITER character entirely, not just its prefix", () => {
    // Confirmed by reproduction: Git stores and echoes
    // "?access_token=abc'def" verbatim. An earlier version of this
    // function bounded the query search with HARD_DELIMITER (the same
    // delimiter used for the non-query case), which stopped at the "'"
    // *inside* the secret, leaving "def" to leak back in as unprocessed
    // trailing text — the query's own content is opaque and can contain
    // any character, so it can't be bounded the same way a URL's host+path
    // safely can.
    const text = "https://example.com/repo.git?access_token=abc'def";

    expect(redactUrlLikeCredentialsInText(text)).toBe("https://example.com/repo.git");
  });

  it("drops a query value containing a raw space entirely, not just its prefix", () => {
    // Confirmed by reproduction: Git stores and echoes
    // "?access_token=abc def" verbatim — no percent-encoding enforced.
    // Whitespace was the last delimiter this function tried using to bound
    // a query; this is the reproduction that ruled it out too.
    const text = "https://example.com/repo.git?access_token=abc def";

    expect(redactUrlLikeCredentialsInText(text)).toBe("https://example.com/repo.git");
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

  it("leaves a URL with an underscore-ending path segment untouched", () => {
    // Confirmed by reproduction that Git accepts and echoes such URLs
    // verbatim (see the equivalent remote.ts regression test) — "_" right
    // before "/" is ordinary in real repo/path names, not a local-path
    // marker boundary.
    const text = "error: pathspec 'https://example.invalid/org/my_repo/x.git' did not match";

    expect(redactAbsolutePathsInText(text)).toBe(text);
  });

  it("leaves text with no absolute path unchanged", () => {
    const text = "fatal: not a git repository (or any of the parent directories): .git";

    expect(redactAbsolutePathsInText(text)).toBe(text);
  });

  it("redacts a path at the very start of the text, consuming to the end when unquoted and no quote follows", () => {
    // Consuming to the true end of the text (not stopping at whitespace) is
    // what makes a space-containing unquoted path (see the dedicated test
    // below) fully redactable — the cost is over-redacting trailing prose
    // in a case like this one, favoring never leaking a path over
    // preserving unrelated surrounding text.
    expect(redactAbsolutePathsInText("/etc/passwd: permission denied")).toBe("<path>");
  });

  it("redacts a file:// URL Git echoes back verbatim, not just bare paths", () => {
    // redactUrlLikeCredentialsInText alone leaves this untouched: a file:
    // URL with no userinfo has no *credential* to strip, but its host+path
    // IS a local filesystem path — this function's job, not that one's.
    const text = "error: pathspec 'file:///Users/alice/private.git' did not match";

    expect(redactAbsolutePathsInText(text)).toBe("error: pathspec '<path>' did not match");
  });

  it("redacts a single-slash file: URL", () => {
    expect(redactAbsolutePathsInText("fatal: unable to access 'file:/Users/alice/x.git'")).toBe(
      "fatal: unable to access '<path>'",
    );
  });

  it("redacts every bare absolute path Git quotes when a checkout target is outside the repo", () => {
    // Confirmed by reproduction: `git checkout /tmp/secret` run inside an
    // unrelated repo produces exactly this shape, with the same absolute
    // path echoed three times (once bare, twice quoted) plus the repo's own
    // absolute root also quoted. Bare paths have no distinctive prefix of
    // their own — this only works because the quote character remains a
    // valid boundary for the bare-path alternative.
    const text =
      "fatal: /tmp/secret: '/tmp/secret' is outside repository at '/private/var/folders/x/tmp.abc123'";

    expect(redactAbsolutePathsInText(text)).toBe(
      "fatal: <path> '<path>' is outside repository at '<path>'",
    );
  });

  it("redacts an unquoted path that itself contains a space", () => {
    // Confirmed by reproduction: a malformed GIT_CONFIG_GLOBAL file under a
    // directory whose name contains a space produces exactly this shape.
    // An earlier version of this function stopped at the first whitespace,
    // leaving " space dir/gitconfig" — the rest of the local path — in the
    // output.
    const text =
      "fatal: bad config line 1 in file /var/folders/x/T/tmp.abc/iroha space dir/gitconfig";

    expect(redactAbsolutePathsInText(text)).toBe("fatal: bad config line 1 in file <path>");
  });

  it("redacts a quoted file: path that itself contains a space", () => {
    // Confirmed by reproduction: `git checkout "file:///Users/alice/private repo.git"`
    // (an unmatched pathspec) produces exactly this shape.
    const text =
      "error: pathspec 'file:///Users/alice/private repo.git' did not match any file(s) known to git";

    expect(redactAbsolutePathsInText(text)).toBe(
      "error: pathspec '<path>' did not match any file(s) known to git",
    );
  });

  it("redacts a home-relative path echoed back in Git's own text", () => {
    // Confirmed by reproduction (see remote.ts's equivalent test): Git
    // accepts and expands both "~/" and "~user/" as local paths.
    const text = "error: pathspec '~/private.git' did not match any file(s) known to git";

    expect(redactAbsolutePathsInText(text)).toBe(
      "error: pathspec '<path>' did not match any file(s) known to git",
    );
  });
});
