# iroha — Background

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Product name / plugin name / CLI name: **iroha**

## 1. この文書の目的

この文書は、irohaを開発する背景、解決したい問題、プロダクトの方向性、設計原則を記録する。調査根拠は [research.md](./research.md)、機能要件は [requirements.md](./requirements.md)、技術設計は [design.md](./design.md) を参照する。

## 2. 背景

Claude CodeやCodexを使った開発では、1回のセッション内では高い生産性を得られる一方、セッションや担当者、AIエージェントをまたぐと、次の情報が分断されやすい。

- なぜその設計を選んだのか
- どのIssueを、誰の、どのエージェントセッションで実装したのか
- どのファイル・シンボルを変更し、何を検証したのか
- どのPRと関連し、どのレビュー指摘を受けたのか
- 過去の失敗、インシデント、レビューからどのルールが生まれたのか
- 現在有効なルールと、廃止・置換されたルールはどれか

既存の`CLAUDE.md`、`AGENTS.md`、README、設計ドキュメントは重要だが、情報が静的な文書として散在し、Issue、PR、レビュー、セッションとの関係が明示されないことが多い。また、Claude CodeとCodexのネイティブメモリは個人・マシンローカルな補助記憶であり、承認、出典、履歴、チーム共有を中心とした知識基盤ではない。

## 3. 解決する問題

### 3.1 AIエージェント側の問題

- 過去の意思決定を知らず、既存方針と異なる独自実装を行う
- 同じ調査、失敗、レビュー指摘をセッションごとに繰り返す
- コンテキスト圧縮やセッション再開後に、重要な前提が薄れる
- 適用範囲の違うルールを区別できず、無関係なルールまで読み込む
- Claude CodeとCodexの間で知識を引き継げない

### 3.2 エンジニア組織側の問題

- 実装の経緯がチャット、Issue、PR、レビュー、口頭説明へ分散する
- レビュー指摘が一度きりのコメントで終わり、組織知へ昇格しない
- 新しいメンバーが過去の判断やドメイン知識を発見しにくい
- 複数のAIセッションで何が進み、何が未解決なのか把握しにくい
- 生産性の可視化が、個人監視や単純な作業量ランキングへ寄りやすい

## 4. プロダクトビジョン

irohaは、Claude CodeとCodexを横断し、開発セッション、Issue、実装、Commit、PR、レビュー、意思決定、開発ルール、インシデントを、出典と人間の承認付きで結びつける、ローカルファーストな **Engineering Memory Graph** である。

目指す状態は次の通り。

1. エージェントは作業開始時に、現在のタスクと変更対象に関連する知識だけを受け取る。
2. エージェントは作業中に、承認済みルールと過去の意思決定を参照できる。
3. 意味のある作業単位ごとに、実装内容・判断・検証・未解決事項が構造化Checkpointとして残る。
4. 人間はダッシュボードで候補を確認し、承認した知識だけをチーム共有できる。
5. 承認済み知識はGitで共有され、別の開発者がpullとsyncを行うだけで利用できる。
6. Issueから実装、PR、レビュー、ルール化までの関係を、人間とエージェントの両方が検索・追跡できる。

## 5. プロダクトの位置づけ

irohaは次のいずれか単体ではない。

- 汎用チャット履歴ビューア
- transcriptの全文検索ツール
- AIエージェントの個人用メモリ
- Issue管理ツールやGitホスティングの代替
- 開発者の作業量を採点する監視ツール
- Claude CodeまたはCodex専用の設定管理ツール

irohaの価値は、複数の一次情報を関係付け、人間の承認を経た再利用可能な知識へ変換し、次の開発セッションへ戻す閉ループにある。

## 6. 想定利用者

### 開発者

- 過去の実装やレビューを自然言語で検索する
- セッション再開時に前提と未解決事項を復元する
- 既存ルールを踏まえたClaude Code/Codexに実装を任せる
- 自分のセッションから生まれた候補を確認・修正・承認する

### Reviewer / Tech Lead

- ある実装が過去のどの判断に基づくか確認する
- 繰り返されるレビュー指摘をルールやパターンへ昇格する
- 競合、重複、陳腐化したルールを発見する

### Engineering Manager / Maintainer

- IssueからPR、レビュー、学習までの流れを俯瞰する
- 個人のランキングではなく、知識の蓄積、レビュー傾向、未解決領域を把握する
- チームのオンボーディングやドメイン知識継承へ利用する

## 7. 設計原則

### 7.1 Local-first

アカウントや常時接続のクラウドサービスを必須にしない。チーム共有の正本はリポジトリ内の`.iroha/`、検索用DBはローカルに置く。

### 7.2 Git is the shared source of truth

チーム共有する知識はレビュー可能なテキストファイルとしてGit管理する。SQLite/libSQLは再構築可能な派生インデックスであり、正本にしない。

### 7.3 Human approval before authority

AIが抽出した意思決定やルールは候補でしかない。人間の承認後に初めて、チームへ共有される権威ある知識になる。

### 7.4 Provenance first

すべての知識は、可能な限りセッション、Issue、PR、レビューコメント、Commit、ファイル、シンボルなどの出典を持つ。

### 7.5 Cross-agent portability

Claude Code固有またはCodex固有のローカルメモリへ依存しない。同じ`.iroha/`を両方のエージェントが利用できることを優先する。

### 7.6 Stable interfaces over internal formats

Claude CodeとCodexのtranscriptは内部形式であり、互換性が保証されない。公式Hook入力、MCP、Git、GitホスティングAPI、明示的な構造化Checkpointを主要インターフェースとする。

### 7.7 Graceful degradation

Embedding API、GitHub/GitLab API、Hookの一部が利用できなくても、Git上の知識、全文検索、CLI、手動Checkpointで基本機能を維持する。

### 7.8 No surveillance

個人別ランキング、稼働時間監視、プロンプト全文のチーム共有を目的にしない。組織向け可視化は、知識、品質、関係、未解決事項を中心にする。

### 7.9 Advisory and enforceable rules are different

自然言語ルールはエージェントへコンテキストとして渡す。機械判定可能な一部ルールだけをHookやCIのGuardrailへコンパイルする。「すべての独自実装を完全に防ぐ」とは表現しない。

## 8. 確定済みの主要判断

| 項目 | 決定 |
|---|---|
| 名称 | iroha |
| 発行主体 | iroha labs / `iroha-labs.com` |
| npm package | `@iroha-labs/iroha`（CLIは`iroha`） |
| 対応対象 | Claude Code、Codex |
| 言語 | TypeScript |
| Toolchain | Node.js `>=24 <25`、pnpm 11、Turborepo、ESM-only |
| Dashboard | React 19.2 + Vite 8.1 SPA |
| Local API | Hono |
| DB | libSQL local database（SQLite互換） |
| ORM | 使用しない。Raw SQL migration + typed repository + Zod |
| チーム共有 | リポジトリ内`.iroha/`をGit管理 |
| ローカルDB | Git内部領域。コミットしない |
| リアルタイム同期 | 不要。pull後の`sync`で反映 |
| Graph | リレーショナルDBの`relations`と再帰CTE。Graph DBは使わない |
| 全文検索 | FTS5 `unicode61` + `trigram` |
| ベクトル検索 | libSQL vector / DiskANN |
| Embedding | 任意。Voyage `voyage-4` / 1024次元。未設定時はFTS-only |
| ID | 型付きULID |
| 生transcript | ローカル限定。正本や安定APIとして扱わない |
| 承認 | 意思決定・ルール等は人間承認後に共有 |

## 9. 成功の定義

初期段階では、次を満たすことを成功とする。

- 既存リポジトリへ短時間で導入できる
- Claude CodeとCodexのどちらからでも同じ承認済み知識を検索できる
- セッション、Issue、PR、レビュー、意思決定の関係を辿れる
- pull後のsyncだけで別メンバーの承認済み知識を利用できる
- transcriptを直接解析しなくても、意味のあるセッションサマリーを構築できる
- 既存の`CLAUDE.md`、`AGENTS.md`、`.claude/rules/`、docsを取り込める
- AIが提案した候補と、人間が承認した知識を明確に区別できる
- Embeddingなしでも基本検索が動作し、Embedding設定時は意味検索が強化される

## 10. 非目標

初期リリースでは以下を目的としない。

- 常時接続型クラウド同期
- リアルタイム共同編集
- GitHub/GitLabの完全な代替
- すべてのエージェントやIDEへの同時対応
- transcript形式への恒久的な互換対応
- 完全自動でのルール承認・公開
- 個人の生産性スコアや監視ダッシュボード
- 大規模な専用Graph DB基盤
- iroha独自のLLM推論課金サービス

## 11. 用語

| 用語 | 意味 |
|---|---|
| Agent Session | Claude Code/Codex上の継続可能な会話スレッド |
| Session Run | 起動または再開から離脱までの実行区間 |
| Turn | 1つのユーザープロンプトを起点とする処理単位 |
| Checkpoint | Turnや作業区間の実装・判断・検証・未解決事項を表す構造化記録 |
| Candidate | AIが抽出した、未承認の知識候補 |
| Knowledge Item | Decision、Rule、Concept、Insight、Incident、Pattern等の知識 |
| Canonical data | Git管理される`.iroha/`内のチーム共有データ |
| Local index | Canonical data等から再構築できるlibSQLデータベース |
| Guardrail | 機械判定可能な承認済みルールを実行時に検査する仕組み |

## 12. 実装への引き渡し

実装判断は確定済みである。Claude Codeは [CLAUDE.md](./CLAUDE.md) を最初に読み、[implementation/implementation-plan.md](./implementation/implementation-plan.md) のWP-00から順に着手する。

詳細仕様は責務ごとに分割している。

- [Compatibility Contract](./implementation/compatibility.md)
- [Canonical Data Contract](./implementation/canonical-schema.md)
- [Database Contract](./implementation/database-schema.md)
- [MCP Contract](./implementation/mcp-contract.md)
- [Hook Contract](./implementation/hooks-contract.md)
- [Dashboard/API Contract](./implementation/dashboard-api.md)
- [First Vertical Slice](./implementation/vertical-slice.md)
- [Implementation Decision Log](./implementation/decision-log.md)

実装を止める未確定事項はない。公開ライセンスの選択と外部公開操作だけは、初回リリース前の人間判断ゲートとして残す。
