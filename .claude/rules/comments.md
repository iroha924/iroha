# Comments: few, terse, and only about the logic

Default to no comment. The code, names, and types carry the intent. Add a comment only where a reader would otherwise misread the logic, and keep it to one line where possible. A verbose comment is as much a defect as a missing one.

## A comment must say what the code cannot

Write one only for:

- a non-obvious invariant, or a constraint enforced elsewhere (a DB CHECK, a schema, a caller contract);
- a subtle edge case or ordering requirement;
- why this approach and not the obvious alternative, when that choice is load-bearing.

If the comment only restates the line below it, delete it.

## Never write history or narrative in code

Code is read in its final state, not as a diff. Do not narrate how it got there:

- no "added in vX", "new in ...", "now supports ...";
- no "previously ...", "changed because ...", "was Y, now Z", "renamed from ...";
- no justifying a change against the old code, and no migration/shim breadcrumbs.

That context belongs in git history and the pull request, not in the source. A decision's *reasoning* may stay (see above); its chronology may not.

## Do not count a set whose members live somewhere else

"Two residual divergences", "exact for enums and patterns", "the three shapes below" — when the cases themselves are documented in other files or the set is open-ended, the count is the first thing to go wrong and the next reader trusts it over the list. Describe each case where it lives, and name the set by its property rather than its size.

A numbered procedure whose steps are immediately below it is not this. Adding a sixth step to a list of five forces the renumber in the same edit, so nothing can silently disagree.

This is also not the stale-claim rule below. Both halves can be individually true and verified and still contradict: one comment records that the timestamp arm has a residual difference, while a summary in another file says patterns are exact. Nothing decayed — they were written at different moments and never read together.

So before writing a comment that characterizes a set, grep for the other comments about that set and read them in one pass. Both occurrences of this in one change — a "three shapes" list that had four, a "two residuals" summary that had three — were caught by a reviewer, not by the author.

## When editing

Delete comments that have decayed into restatement, narrative, or a stale claim. Removing a comment that no longer earns its place is part of the change, not scope creep.

## Related

- Do not add comments to code you did not change: `~/.claude/rules/code-quality.md`.
- Fewer concepts overall: KISS in `~/.claude/CLAUDE.md`.
