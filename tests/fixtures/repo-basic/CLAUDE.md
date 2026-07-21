# repo-basic

Synthetic fixture repository for iroha's vertical slice. Everything here is fake
and deterministic; it exists only so the integration harness can drive the full
product loop against a realistic-looking project.

## Architecture

- Payments use the **repository pattern**: `PaymentService` depends on a
  `PaymentRepository` port, never on a concrete data store.

## Conventions

- Do not edit files under `src/generated/**` directly. They are produced by the
  code generator and overwritten on the next build.
- Any change under `src/payments/**` requires running `pnpm test payments`
  before commit.
- The current work item is issue GH-42.
