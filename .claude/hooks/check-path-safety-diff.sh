#!/usr/bin/env bash
# PreToolUse hook on `Bash(git push *)`.
#
# WP-02 history: `path.resolve`/`path.join`/`path.normalize` lexically collapse
# ".." before symlinks in the path are resolved, which reopened a traversal
# bug three separate times in packages/git/src/paths.ts across review rounds.
# This hook doesn't try to judge whether a new call is safe (that needs
# reading the surrounding code) — it just guarantees a human looks at it
# before it ships, by escalating the push to an approval prompt instead of
# letting it go through silently.
set -euo pipefail

# settings.json gates this with `if: "Bash(git push *)"`, but that filter is
# documented as best-effort: when it cannot parse the command it fails open and
# runs the hook regardless of the pattern, and a heredoc is enough to defeat it.
# So an ordinary `cat <<EOF ... && vitest` was raising a push-approval prompt.
# Re-checking the command here is what actually restricts this to a push.
INPUT=$(cat 2>/dev/null || true)
# Deliberately matches `push` alone rather than the literal `git push`: git accepts
# global options before the subcommand (`git -C <path> push`), and a payload the
# filter could not parse is exactly the shape most likely to carry one. Erring
# toward running the check costs a redundant diff scan that prints nothing;
# erring the other way silently skips the guard on a real push.
if [ -n "$INPUT" ] && ! printf '%s' "$INPUT" | grep -q 'push'; then
  exit 0
fi

UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -z "$UPSTREAM" ]; then
  # No upstream yet — most commonly the first push of a new branch (e.g.
  # `git push -u origin HEAD`), which runs before the push sets up tracking.
  # Falling back to the merge-base with main still scans every commit this
  # branch is about to publish, instead of silently skipping the exact push
  # where a large, unreviewed diff is most likely to ship.
  UPSTREAM=$(git rev-parse --verify origin/main 2>/dev/null || git rev-parse --verify main 2>/dev/null || true)
  if [ -z "$UPSTREAM" ]; then
    exit 0
  fi
fi

DIFF=$(git diff "$UPSTREAM...HEAD" -- 'packages/*/src/*paths*.ts' 'packages/*/src/*credential*.ts' 2>/dev/null || true)
if [ -z "$DIFF" ]; then
  exit 0
fi

ADDED=$(echo "$DIFF" | grep -E '^\+' | grep -Fv '+++' || true)
if [ -z "$ADDED" ]; then
  exit 0
fi

if echo "$ADDED" | grep -qE '\.(resolve|join|normalize)\('; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"This push adds a new path.resolve()/path.join()/path.normalize() call in a *paths*.ts or *credential*.ts file under packages/*/src/. These files declare an invariant against lexically collapsing '..' before symlinks are resolved (see .claude/rules/path-and-symlink-safety.md). Verify the new call can never receive a string containing '..' before any symlink in it is dereferenced, then approve."}}
EOF
fi

exit 0
