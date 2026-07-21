# repo-basic — agent instructions

Codex and other agents read this file. It mirrors `CLAUDE.md` for the same
synthetic project.

- Architecture: payments follow the repository pattern
  (`PaymentService` → `PaymentRepository` port).
- Never edit `src/generated/**` by hand; regenerate instead.
- Run `pnpm test payments` after touching `src/payments/**`.
- Active issue: GH-42.
