# iroha — Requirements

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Inputs: [background.md](./background.md), [research.md](./research.md)

## 1. 目的

この文書は、irohaが提供すべき機能、品質、制約、MVP境界、受け入れ条件を定義する。具体的な実装方法は [design.md](./design.md) に記載する。

## 2. スコープ

### 2.1 MVPの対象

- 既存のGitリポジトリへirohaを初期導入する
- Claude CodeとCodexのPlugin/Skill/Hook/MCP連携
- セッション、Run、Turn、Tool event、Checkpointのローカル記録
- 承認済みセッションサマリー・意思決定・ルール等のGit共有
- `.iroha/`からのローカルDB再構築
- 日本語、英語、コードを対象とした全文検索と意味検索
- Issue、Commit、PR、Review、Knowledgeの関係管理
- 候補の確認、編集、承認、却下を行うローカルDashboard
- pull後の明示的なsync
- GitHub/GitLab連携のためのprovider interface
- scoped npm package `@iroha-labs/iroha`と、Claude Code/Codex用の別manifestを持つ配布物

### 2.2 MVPの対象外

- 常時接続のirohaクラウド
- リアルタイムの端末間同期
- 複数ユーザーが同時編集するWeb SaaS
- raw transcriptのGit共有
- 個人別生産性ランキング
- 専用Graph DB
- 自動承認された組織ルール
- Claude Code/Codex以外のエージェント対応
- GitHub/GitLabのIssue・PR UIの完全代替

## 3. ユーザーストーリー

### Developer

- 開発者として、作業開始時に現在のIssueと変更対象に関連する過去の判断を受け取りたい。
- 開発者として、自然言語で「以前この認証方式を選んだ理由」を検索したい。
- 開発者として、セッションの実装内容、検証、未解決事項を次回へ引き継ぎたい。
- 開発者として、AIが提案した知識を公開前に確認・修正したい。
- 開発者として、別メンバーが承認した知識をpullとsyncだけで利用したい。

### Reviewer / Tech Lead

- Reviewerとして、PRがどのIssue、セッション、意思決定に基づくか確認したい。
- Tech Leadとして、繰り返されるレビュー指摘をルール候補へ昇格したい。
- Tech Leadとして、矛盾または置換関係にあるルールを発見したい。

### Engineering Manager / Maintainer

- Maintainerとして、個人の作業量ではなく、Issueから学習までの流れを把握したい。
- Maintainerとして、知識が不足している領域や未解決事項を確認したい。
- Maintainerとして、新メンバーに関連セッションと設計判断を案内したい。

## 4. 機能要件

Priority:

- **P0**: MVPの成立に必須
- **P1**: MVP直後に必要
- **P2**: 将来拡張

### 4.1 Initialization / Configuration

| ID | Priority | Requirement |
|---|---:|---|
| FR-001 | P0 | `iroha init`はGit rootを検出し、`.iroha/`、設定、schema version、必要なignore設定を安全に作成する |
| FR-002 | P0 | 既存ファイルを無断で上書きせず、再実行可能である |
| FR-003 | P0 | Claude CodeとCodexの利用可否、Hook状態、DB、Embedding設定を検査するdoctor機能を持つ |
| FR-004 | P0 | `CLAUDE.md`、`AGENTS.md`、`.claude/rules/`、ユーザー指定docsを初期scanできる |
| FR-005 | P0 | Embedding未設定でもFTS-only modeで利用できる |
| FR-006 | P1 | 複数Embedding providerを設定可能にする |

### 4.2 Platform integration

| ID | Priority | Requirement |
|---|---:|---|
| FR-010 | P0 | Claude Code Plugin名を`iroha`とし、`/iroha:*` Skillを提供する |
| FR-011 | P0 | Codex Plugin名を`iroha`とし、`$iroha:*` Skillを提供する |
| FR-012 | P0 | 共通CLIとして`iroha <command>`を提供する |
| FR-013 | P0 | 両Pluginは同じTypeScript core、MCP server、canonical dataを利用する |
| FR-014 | P0 | Codex Hookのtrust未完了を検出し、解決手順を示す |
| FR-015 | P0 | Hookが無効な場合も、Skill/CLIによる手動操作を利用できる |

### 4.3 Session lifecycle

| ID | Priority | Requirement |
|---|---:|---|
| FR-020 | P0 | `SessionStart`でplatform sessionとiroha sessionを対応付ける |
| FR-021 | P0 | startup、resume、clear、compactを区別する |
| FR-022 | P0 | 同一会話の再開を同じAgent Session、別Session Runとして記録する |
| FR-023 | P0 | `UserPromptSubmit`ごとにTurnを作成し、platform turn/prompt IDを保持する |
| FR-024 | P0 | Tool eventをTurnへ関連付け、tool名、対象、結果状態、時刻を記録する |
| FR-025 | P0 | 意味のある作業単位を構造化Checkpointとして記録する |
| FR-026 | P0 | 必要なCheckpointがない場合、`Stop`で最大1回だけ継続を要求する |
| FR-027 | P0 | 圧縮後に、承認済みルールと直近Checkpointを再注入できる |
| FR-028 | P0 | 中断・クラッシュしたRunを次回起動時に検出し、interruptedへ遷移できる |
| FR-029 | P0 | Claude Codeの`SessionEnd`はRun終了記録に利用し、重い処理を実行しない |
| FR-030 | P1 | Subagent sessionと親sessionの関係を記録する |

### 4.4 Checkpoint / knowledge extraction

| ID | Priority | Requirement |
|---|---:|---|
| FR-040 | P0 | Checkpointは目的、結果、変更箇所、判断、検証、未解決事項、関連参照を構造化して保持する |
| FR-041 | P0 | Checkpoint生成は現在動作中のClaude/CodexがMCP toolを呼ぶ方式とし、別LLM APIを必須にしない |
| FR-042 | P0 | CheckpointからSession Summary候補を作成できる |
| FR-043 | P0 | Decision、Rule、Concept、Insight、Incident、Pattern候補を作成できる |
| FR-044 | P0 | 各候補は出典、confidence、作成者、作成セッション、状態を持つ |
| FR-045 | P0 | 候補はdraft、approved、rejected、supersededの状態を区別する |
| FR-046 | P0 | approvedになるまで、候補を権威あるコンテキストとして注入しない |
| FR-047 | P1 | 重複・矛盾・置換候補を提示する |

### 4.5 Human approval / publishing

| ID | Priority | Requirement |
|---|---:|---|
| FR-050 | P0 | Dashboardで未承認候補を一覧、詳細表示、編集できる |
| FR-051 | P0 | 人間が候補をapprove、rejectできる |
| FR-052 | P0 | approve時にcanonical `.iroha/`ファイルを先に書き、その後local DBを更新する |
| FR-053 | P0 | DB更新に失敗してもcanonical fileから再構築できる |
| FR-054 | P0 | 承認者、承認時刻、元候補、出典を追跡できる |
| FR-055 | P0 | raw prompt、raw transcript、secretらしき値を自動公開しない |
| FR-056 | P1 | Session Summaryのauto-publishを将来設定可能にする。初期値はoffとする |

### 4.6 Sync / rebuild

| ID | Priority | Requirement |
|---|---:|---|
| FR-060 | P0 | `iroha sync`は`.iroha/`の変更をlocal DBへ反映する |
| FR-061 | P0 | syncはidempotentであり、同じ入力から同じentity/relationを生成する |
| FR-062 | P0 | local DBを削除しても`.iroha/`から再構築できる |
| FR-063 | P0 | pull後に明示的なsyncを実行する運用をサポートする |
| FR-064 | P1 | post-mergeまたはsession-startでの軽量syncを設定可能にする |
| FR-065 | P0 | schema versionを検査し、非対応versionを黙って読み込まない |
| FR-066 | P1 | GitHub/GitLab APIからIssue、PR、Reviewを増分取得する |
| FR-067 | P1 | 外部APIが利用できなくても、canonical dataとGit情報だけでsyncを完了する |

### 4.7 Search / retrieval

| ID | Priority | Requirement |
|---|---:|---|
| FR-070 | P0 | 日本語、英語、コード識別子を全文検索できる |
| FR-071 | P0 | Embedding設定時にvector searchを利用できる |
| FR-072 | P0 | text、vector、authority、graph proximity、file/symbol、label、recencyを組み合わせたhybrid retrievalを提供する |
| FR-073 | P0 | 検索結果に種類、要約、出典、状態、関連entityを表示する |
| FR-074 | P0 | 未承認候補を通常のエージェントコンテキストから除外する |
| FR-075 | P0 | `SessionStart`と`UserPromptSubmit`で、token budget内のcontext packを生成する |
| FR-076 | P0 | CLIとMCPの両方から検索できる |
| FR-077 | P1 | file path、symbol、label、entity type、期間、authorityでfilterできる |

### 4.8 Relations / provenance

| ID | Priority | Requirement |
|---|---:|---|
| FR-080 | P0 | Session、Issue、Commit、PR、Review、Knowledge、File、Symbolをentityとして関係付ける |
| FR-081 | P0 | relationはtype、source、confidence、created_atを持つ |
| FR-082 | P0 | Decision/Ruleから根拠となったSession/Reviewへ辿れる |
| FR-083 | P0 | Issueから実装Session、Commit/PR、Review、学習項目へ辿れる |
| FR-084 | P1 | recursive relation queryを提供する |
| FR-085 | P1 | 同一entityへの重複relationを正規化する |

### 4.9 Guardrails

| ID | Priority | Requirement |
|---|---:|---|
| FR-090 | P0 | Ruleをadvisoryとguardrailへ分類する |
| FR-091 | P0 | Guardrailは機械判定可能なspecを持つ場合だけ実行可能状態にする |
| FR-092 | P0 | `PreToolUse`で対象tool/path/commandに関係するGuardrailを評価できる |
| FR-093 | P0 | deny時に、適用Ruleと理由をエージェントへ返す |
| FR-094 | P0 | Hookで完全に強制できない範囲をUIとdocsで明示する |
| FR-095 | P1 | GuardrailからCI用checkを生成できる拡張点を用意する |

### 4.10 Dashboard

| ID | Priority | Requirement |
|---|---:|---|
| FR-100 | P0 | `iroha dashboard`でlocalhost上にDashboardを起動する |
| FR-101 | P0 | Session一覧・詳細・Run・Turn・Checkpointを表示する |
| FR-102 | P0 | Candidate review queueを提供する |
| FR-103 | P0 | Knowledge一覧・詳細・関係を表示する |
| FR-104 | P0 | 自然言語検索UIを提供する |
| FR-105 | P0 | Issue → Session → PR → Review → Knowledgeの関連を表示する |
| FR-106 | P1 | 種類、label、期間、repository、statusによるfilterを提供する |
| FR-107 | P1 | 知識蓄積、未解決事項、レビュー由来ルール等の集計を可視化する |
| FR-108 | P0 | 個人のランキングや単純な優劣スコアを表示しない |

### 4.11 Privacy / data control

| ID | Priority | Requirement |
|---|---:|---|
| FR-110 | P0 | raw transcriptとraw promptをcanonical dataへ保存しない |
| FR-111 | P0 | local event dataの保持期間または削除を設定できる |
| FR-112 | P0 | secret patternを検知し、candidate公開前に警告またはredactする |
| FR-113 | P0 | 外部Embeddingへ送信するtextを設定・確認可能にする |
| FR-114 | P0 | local DBを削除してもGit管理データを失わない |
| FR-115 | P1 | repository単位のexport/deleteを提供する |

## 5. 非機能要件

### NFR-001: Local-first / Offline degradation

- iroha独自アカウントを要求しない
- Dashboardはlocalhostで動作する
- ネットワーク未接続時も、canonical data、FTS、Graph query、Dashboardを利用できる

### NFR-002: Durability

- Hook eventとCheckpoint書き込みはcrash-safeなtransactionで処理する
- canonical writeは一時ファイルからのatomic renameを利用する
- DBは常に再構築可能にする

### NFR-003: Performance targets

fixture repository、warm local DB、Embedding生成済みまたはFTS-onlyを基準に、初期目標を次とする。詳細なHook上限は [Hook Contract](./implementation/hooks-contract.md) を正本とする。

- `SessionStart` context生成: p95 1秒以内
- `UserPromptSubmit` retrieval: p95 300ms以内（Embedding生成済みの場合）
- `PreToolUse` Guardrail: p95 100ms以内
- Dashboard初期表示: 2秒以内（1万entity規模）
- Hook timeout時はagent処理を不要に停止させない

### NFR-004: Compatibility

- platform固有schemaはadapter境界で正規化する
- Node.js `>=24 <25`、Claude Code `>=2.1.198`、Codex `>=0.144.5`を最低対応とする
- Tier 1はmacOS 14 arm64/x64、Ubuntu 22.04 arm64/x64、Windows 11 x64、WSL2とする
- semverだけでなくcapabilityを`iroha doctor`で検査する
- Hook contract fixtureを用意する
- schema migrationはforward-onlyとし、version管理する

### NFR-005: Security

- Plugin bundle内の実行物を固定し、予期しないinstall lifecycle scriptへ依存しない
- Hook inputを信頼せずZodでvalidationする
- shell引数の組み立てを避け、可能な場所ではexec形式を使う
- secret、credential、token、個人情報をログへ出さない
- Dashboardはデフォルトでloopback interfaceだけにbindする
- Dashboard起動tokenをURL fragmentで一度だけ受け渡し、HttpOnly/SameSite=Strict cookieへ交換する
- state-changing APIはcookie、厳密なOrigin、JSON Content-Type、`X-Iroha-Request: 1`を要求する

### NFR-006: Explainability

- 検索結果、Guardrail、候補には根拠と出典を表示する
- AI生成候補と人間承認済み知識を明確に区別する
- relationが自動推定か、API由来か、人間作成かを保持する

### NFR-007: Maintainability

- TypeScript strict modeを使用する
- Core domainはClaude/Codex SDK型から独立させる
- Raw SQLはmigrationとquery moduleへ集約する
- Zod schemaをboundary validationとcanonical file validationへ利用する

### NFR-008: Ethical analytics

- 個人評価に直結するランキングを作らない
- 可視化は知識フロー、品質シグナル、未解決事項を中心にする
- Prompt本文や会話本文を管理者向けに無断公開しない

## 6. データ要件

### Canonicalに保存可能

- 承認済みSession Summary
- 承認済みDecision / Rule / Concept / Insight / Incident / Pattern
- taxonomy / labels
- 出典参照、外部URL、Commit SHA、file path、symbol
- schema versionと共有設定

### Local DBのみに保存

- 未承認Candidate
- Hook eventの詳細
- platform session/turn mapping
- rawに近いTool resultの要約・digest
- Embedding vector
- sync cursor / cache
- Dashboardのlocal preference

### デフォルトで保存しない

- raw transcriptのコピー
- raw prompt全文のGit共有
- credential / secret
- model thinking / reasoning trace
- 個人の評価スコア

## 7. MVP受け入れシナリオ

### Scenario A: 初期導入

1. DeveloperがGit repositoryで`iroha init`を実行する
2. `.iroha/`とlocal DBが作成される
3. 既存`AGENTS.md`または`CLAUDE.md`がscanされる
4. doctorがClaude Code/Codex、Hook trust、Embedding状態を表示する
5. 再実行しても既存データを破壊しない

### Scenario B: Agent sessionから知識を保存

1. Claude CodeまたはCodexを起動する
2. `SessionStart`で関連ルールが注入される
3. 実装中のTool eventがTurnへ関連付く
4. AgentがMCP Checkpoint toolを呼ぶ
5. DashboardにSession SummaryとDecision候補が表示される
6. 人間が修正・approveする
7. `.iroha/`へcanonical fileが生成される

### Scenario C: チーム共有

1. Developer Aが承認済み知識をcommit/pushする
2. Developer Bがpullする
3. Developer Bが`iroha sync`を実行する
4. Developer Bのlocal DBへ反映される
5. Claude CodeとCodexの両方で同じ知識を検索できる

### Scenario D: 中断と再開

1. Agentが実装途中で強制終了する
2. 直前までのlocal Tool eventとCheckpointは残る
3. 次回`SessionStart`で未完了Runを検出する
4. 直近Checkpointと未解決事項を再注入する

### Scenario E: DB再構築

1. local DBを削除する
2. `iroha sync --rebuild`を実行する
3. `.iroha/`とGit情報から承認済みentity/relation/search documentが復元される
4. Embeddingは必要に応じて再生成される

## 8. Release criteria

MVP releaseには少なくとも以下を必要とする。

- Claude CodeとCodexのSessionStart/UserPromptSubmit/Stopのcontract test
- Crash recovery test
- Canonical file round-trip test
- DB full rebuild test
- 日本語・英語・コード検索test
- Candidate approve/reject test
- Secret redaction test
- Hook disabled/trust missing時のfallback test
- 同一repositoryの複数worktree test
- 1万entity規模の基本performance test
- JSON Schemaのpositive/negative fixtureとZodの同値test
- libSQL migrationのempty DB、integrity、FTS、vector capability test
- Plugin archiveがinstall lifecycle scriptやsource workspaceなしで動くpackage smoke test
- Tier 1 OSのpath space、非ASCII path、CRLF、worktree test

## 9. 確定済み実装判断

| ID | Decision | 正本 |
|---|---|---|
| OQ-001 | pnpm 11 workspaces + Turborepo、単一lockfile、`workspace:*` | [Compatibility](./implementation/compatibility.md) |
| OQ-002 | Claude Code >=2.1.198、Codex >=0.144.5、capability detection併用 | [Compatibility](./implementation/compatibility.md) |
| OQ-003 | macOS 14、Ubuntu 22.04、Windows 11、WSL2をTier 1 | [Compatibility](./implementation/compatibility.md) |
| OQ-004 | Git metadataをP0、GitHubを最初のP1、GitLabはport/fixture | [Compatibility](./implementation/compatibility.md) |
| OQ-005 | FTS-onlyを既定、任意でVoyage `voyage-4` / 1024次元 | [Compatibility](./implementation/compatibility.md) |
| OQ-006 | Checkpoint field、上限、guard条件をJSON Schemaで固定 | [Checkpoint Schema](./schemas/checkpoint-v1.schema.json) |
| OQ-007 | 1 Agent Sessionにつき1 canonical Summary、修正は再承認とrevision増加 | [Canonical](./implementation/canonical-schema.md) |
| OQ-008 | RRF初期式と60-query評価dataset/thresholdを固定 | [Database](./implementation/database-schema.md) |
| OQ-009 | `.iroha/` path、frontmatter、body、serializationを固定 | [Canonical](./implementation/canonical-schema.md) |
| OQ-010 | scoped npm + GitHub Releases + dual marketplace、checksum/SBOM/attestation | [Compatibility](./implementation/compatibility.md) |

実装を開始するためのOpen Questionは残っていない。公開ライセンスの選択、npm/Release/Marketplaceへの実公開、canonical v1の破壊的変更、外部送信データ種別の追加は人間判断ゲートとする。
