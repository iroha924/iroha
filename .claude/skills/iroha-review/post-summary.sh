#!/usr/bin/env bash
# Post the iroha-review summary as one sticky PR comment, or refuse and say why.
#
# Run this after `gh pr create` (see CLAUDE.md / AGENTS.md). The iroha-review skill never runs it:
# drafting and posting are deliberately separate, so a review can be re-read before it is published.
#
# The comment is identified by its hidden marker, never by author — `gh pr comment --edit-last`
# targets the current user's *last* comment, which in this repo's workflow is routinely a
# Codex trigger comment or a triage reply (see .claude/skills/pr-review-status/SKILL.md), and editing
# that would destroy the triage record.
set -euo pipefail

MARKER='<!-- iroha-review-summary -->'

draft="$(git rev-parse --git-path iroha-review-draft.md)"
if [ ! -f "$draft" ]; then
  echo "No iroha-review draft. The review is optional, so there is nothing to post."
  exit 0
fi

# The draft records the commit it is current as of. A single fixed draft path means a draft can
# outlive the branch it was written on; posting it against a different HEAD would attach a summary
# that misdescribes the diff, which is worse than posting nothing.
drafted_line="$(grep -m1 -oE 'iroha-review-draft-head: [0-9a-f]{40}' "$draft" || true)"
drafted="${drafted_line##* }"
current="$(git rev-parse HEAD)"
if [ "$drafted" != "$current" ]; then
  echo "Refusing to post: the draft is current at ${drafted:-<no readable draft-head marker>},"
  echo "but HEAD is ${current}."
  echo "If findings were fixed after drafting, update the Outcome rows and the draft-head marker;"
  echo "otherwise re-run /iroha-review against the current HEAD."
  exit 1
fi

# An @-mention in the body fires for real: the posting account has write access, and the Codex trigger
# phrase in a body full of other text starts a cloud chat rather than a review (it happened on PR #191,
# from a finding that merely quoted the phrase). The template forbids mentions, but a rule that only
# exists in prose does not survive a generated body, so enforce it here. `@` not followed by an
# identifier character is fine — that is how the template refers to mentions in the first place.
if mentions="$(grep -nE '@[A-Za-z0-9]' "$draft")"; then
  echo "Refusing to post: the draft contains an @-mention, which would notify a real account or start"
  echo "a Codex cloud chat. Name the bot and its triggers in prose instead. Offending lines:"
  printf '%s\n' "$mentions"
  exit 1
fi

# Distinguish "no PR" from a lookup that failed for another reason — swallowing stderr here would
# report "create a PR first" for what is actually an auth or connectivity problem.
if ! pr_info="$(gh pr view --json number,baseRefName --jq '"\(.number) \(.baseRefName)"' 2>&1)"; then
  case "$pr_info" in
    *"no pull requests found"*)
      echo "No pull request for the current branch. Create it first, then re-run this." ;;
    *)
      echo "Could not look up the pull request — this is not the same as there being none:"
      printf '%s\n' "$pr_info" ;;
  esac
  exit 1
fi
pr="${pr_info%% *}"
pr_base="${pr_info##* }"

# The review computed its range against the default branch, so a PR targeting anything else has a
# different diff than the one the draft describes.
default_base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
default_base="${default_base:-main}"
if [ "$pr_base" != "$default_base" ]; then
  echo "Refusing to post: PR #${pr} targets '${pr_base}', but the review computed its range against"
  echo "'${default_base}'. Re-review against the PR's actual base before posting."
  exit 1
fi

# Matching the draft against local HEAD is not enough: with an unpushed commit, or a remote branch
# that advanced independently, the draft can be current locally while the PR points somewhere else —
# and the comment would then describe a diff that is not on the PR at all.
pr_head="$(gh pr view "$pr" --json headRefOid --jq .headRefOid)"
if [ "$pr_head" != "$current" ]; then
  echo "Refusing to post: PR #${pr} is at ${pr_head}, but the draft describes ${current}."
  echo "Push the branch (or re-review the pushed commit) before posting."
  exit 1
fi

# Scope the search to comments this account owns. The marker is the identifier, but on a public
# repository anyone can post a body containing it, and a maintainer's token can edit other people's
# comments — so marker alone would overwrite a stranger's comment and never update the real summary.
me="$(gh api user --jq .login)"

# `startswith`, not `contains`: the marker is line 1 of a rendered summary, so a triage reply that
# merely *quotes* it mid-body must not match — otherwise the PATCH below would overwrite that reply
# and leave the real summary stale.
#
# --paginate with --jq applies the filter per page (--slurp cannot be combined with --jq), so this
# emits one id per matching comment across all pages; the last one is the summary of record.
id="$(gh api "repos/{owner}/{repo}/issues/${pr}/comments" --paginate \
  --jq ".[] | select(.user.login == \"${me}\") | select(.body | startswith(\"${MARKER}\")) | .id" \
  | tail -1)"

if [ -n "$id" ]; then
  gh api --method PATCH "repos/{owner}/{repo}/issues/comments/${id}" \
    -F "body=@${draft}" --jq .html_url
else
  gh pr comment "$pr" --body-file "$draft"
fi

# Only reached when the post succeeded (`set -e`), so the comment is the record from here on and the
# draft has no reason to outlive it. Leaving it would accumulate files in .git/ and let a draft from
# one branch be offered on the next. A refusal above deliberately keeps the draft for inspection.
rm -f "$draft"
echo "Posted the summary and removed the draft."
