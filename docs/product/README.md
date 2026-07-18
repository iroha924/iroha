# iroha implementation handoff

> Status: Ready for Claude Code  
> Updated: 2026-07-18

このbundleは、iroha v0.1を空のrepositoryから実装するための確定仕様である。プロダクト名、Plugin名、CLI名はすべて`iroha`。公開npm packageは`@iroha-labs/iroha`。

## Claude Codeへ渡す方法

1. このbundleを新しいiroha repositoryへ展開する。
2. `CLAUDE.md`をrepository rootへ置いた状態でClaude Codeを起動する。
3. 次のpromptを渡す。

```text
CLAUDE.mdと参照仕様を順番に読み、implementation/implementation-plan.mdのWP-00から開始してください。確定済みADRを再設計せず、各WPのacceptanceを実行・記録してから次へ進んでください。まずWP-00だけを完了し、変更ファイル、実行結果、未解決リスクを報告してください。
```

WP-00で、`CLAUDE.md`と`AGENTS.md`以外の仕様を`docs/product/`へ配置し、両agent指示ファイルはrepository rootに維持する。その後は`docs/product/implementation/implementation-plan.md`を基準に進める。

## Document map

| File | Purpose |
|---|---|
| [background.md](./background.md) | 背景、vision、原則、非目標 |
| [research.md](./research.md) | Claude Code/Codex公式仕様と技術調査 |
| [requirements.md](./requirements.md) | P0/P1/P2要件とrelease criteria |
| [design.md](./design.md) | 全体architectureと責務境界 |
| [CLAUDE.md](./CLAUDE.md) | Claude Codeの最上位実装指示 |
| [AGENTS.md](./AGENTS.md) | Codex等への同一指示入口 |
| [implementation/compatibility.md](./implementation/compatibility.md) | version、OS、package、配布 |
| [implementation/canonical-schema.md](./implementation/canonical-schema.md) | Git正本と承認transaction |
| [implementation/database-schema.md](./implementation/database-schema.md) | DB、検索、rebuild |
| [implementation/mcp-contract.md](./implementation/mcp-contract.md) | Agent-facing MCP API |
| [implementation/hooks-contract.md](./implementation/hooks-contract.md) | platform Hook contract |
| [implementation/dashboard-api.md](./implementation/dashboard-api.md) | Human UI/local API/auth |
| [implementation/vertical-slice.md](./implementation/vertical-slice.md) | 最初のE2E受け入れfixture |
| [implementation/decision-log.md](./implementation/decision-log.md) | 確定判断と変更protocol |
| [implementation/implementation-plan.md](./implementation/implementation-plan.md) | WP-00〜WP-12の実装順序 |
| [schemas/](./schemas/) | JSON Schema machine contracts |
| [migrations/001_initial.sql](./migrations/001_initial.sql) | executable libSQL migration |
| [implementation/validation-report.md](./implementation/validation-report.md) | このbundleの検証記録 |

## Authority order

矛盾時の優先順位:

1. `schemas/*.json`と`migrations/*.sql`
2. `implementation/*-contract.md` / `*-schema.md`
3. `design.md`
4. `requirements.md`
5. `background.md`

矛盾を発見した実装者は、黙って一方を採用せず作業を止めて報告する。

## Remaining human gates

local implementationを止める未確定事項はない。次だけは人間の明示判断が必要。

- 初回公開前のlicense選択
- npm、GitHub Release、Marketplaceへの実公開
- canonical v1の破壊的変更
- 新しい外部送信データ、cloud state、telemetryの追加
- Agentへのapproval権限付与
