# iroha

Claude Code と Codex を横断する、ローカルファーストな Engineering Memory Graph。

開発セッション、Issue、実装、Commit、PR、レビュー、意思決定、開発ルール、インシデントを、出典と人間の承認付きで結びつける。

## Specifications

確定仕様は [docs/product/](./docs/product/) を参照。実装指示の入口は [CLAUDE.md](./CLAUDE.md)（Codex 等は [AGENTS.md](./AGENTS.md)）。

## Development

Node.js `>=24 <25` と pnpm 11.14.0（Corepack 経由）が必要。

```bash
corepack pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
