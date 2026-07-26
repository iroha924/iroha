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

## When editing

Delete comments that have decayed into restatement, narrative, or a stale claim. Removing a comment that no longer earns its place is part of the change, not scope creep.

## Related

- Do not add comments to code you did not change: `~/.claude/rules/code-quality.md`.
- Fewer concepts overall: KISS in `~/.claude/CLAUDE.md`.
