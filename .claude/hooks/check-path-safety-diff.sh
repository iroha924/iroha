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

UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -z "$UPSTREAM" ]; then
  exit 0
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
