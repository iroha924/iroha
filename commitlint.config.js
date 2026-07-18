/** Enforces the Conventional Commits format required by ~/.claude/rules/git-commit.md. */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // git-commit.md allows Japanese subjects. This repo's subjects routinely
    // start with an uppercase Latin token (WP-01, MCP, CI, ...); the default
    // English-oriented case check flags that as "sentence-case" even though
    // no casing convention is actually being violated.
    "subject-case": [0],
  },
};
