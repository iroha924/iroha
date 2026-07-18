# iroha — Research

> Status: Implementation Baseline v1  
> Updated: 2026-07-18  
> Scope: Claude Code / Codexの公式仕様と、iroha設計への影響

## 1. 調査目的

irohaが、Claude CodeとCodexの現在の公式機能に対して本当に独立した価値を持つか、また、どの公式拡張ポイントを安定インターフェースとして利用できるかを確認する。

主な調査問いは次の通り。

1. 両ツールのネイティブメモリで、チーム共有の課題は解決済みか
2. セッション、Turn、Tool実行、圧縮、終了をどこまでHookで観測できるか
3. Plugin、Skill、MCPをどの形式で配布できるか
4. transcriptを安定したデータソースとして利用できるか
5. `CLAUDE.md`と`AGENTS.md`をどのように扱うべきか
6. 両プラットフォームで同じユーザー体験をどこまで提供できるか

## 2. 調査方法

- 公式ドキュメントを一次情報として使用した
- CodexはOpenAI公式Codex Manualと公式Learn Docsを確認した
- Claude CodeはAnthropic公式Claude Code Docsを確認した
- Hookについてはイベント一覧だけでなく、matcher、input、output、timeout、trust、失敗時の挙動まで確認した
- 公式に不安定とされる内部形式は設計依存先から除外した

## 3. 主要な結論

### 3.1 ネイティブメモリは強化されたが、irohaと目的が異なる

Claude CodeにはAuto Memoryがあり、リポジトリ単位のローカルメモリへ、Claude自身が有用と判断した情報を保存する。`MEMORY.md`の先頭200行または25KBが各セッション開始時に読み込まれる。全worktreeで共有される一方、別マシンやクラウド環境とは共有されない。

CodexにもローカルMemoriesがあり、過去チャットから有用な情報をバックグラウンド抽出する。ただしローカル機能で、初期状態では無効であり、更新はセッション終了直後とは限らない。OpenAI公式も、必須のチームルールは`AGENTS.md`やGit管理ドキュメントへ置くよう案内している。

したがって、irohaは「ネイティブメモリより賢い個人メモリ」を主訴求にしない。差別化は次に置く。

- Claude CodeとCodexの横断
- Gitによるチーム共有
- 人間の承認
- 出典と変更履歴
- Issue、PR、Review、Commit、File、Symbolとの関係
- 自然言語検索とグラフ探索
- 組織向けダッシュボード

Sources:

- [Claude Code: How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [OpenAI: Codex Memories](https://learn.chatgpt.com/docs/customization/memories)

### 3.2 両方に主要なLifecycle Hookが存在する

当初の想定より、Claude CodeとCodexの共通化可能範囲は広い。

| Event / capability | Claude Code | Codex | irohaでの用途 |
|---|---:|---:|---|
| `SessionStart` | Yes | Yes | Session/Run開始、sync確認、関連知識注入 |
| `UserPromptSubmit` | Yes | Yes | Turn開始、プロンプトに基づく検索・注入 |
| `PreToolUse` | Yes | Yes | 機械判定可能なGuardrail、Tool event開始 |
| `PermissionRequest` | Yes | Yes | 権限要求の観測・限定的なポリシー適用 |
| `PostToolUse` | Yes | Yes | Tool結果、変更対象、関係候補の記録 |
| `PostToolUseFailure` | Yes | No（`PostToolUse`結果から派生） | Tool失敗記録 |
| `SubagentStart` / `Stop` | Yes | Yes | サブエージェント関係の記録 |
| `PreCompact` | Yes | Yes | 圧縮前のローカルCheckpoint |
| `PostCompact` | Yes | Yes | 圧縮完了と再注入 |
| `compact_summary` | Yes | No | Claudeの補助回復情報。正本にはしない |
| `Stop` | Yes | Yes | Checkpoint不足時の一度限りの継続要求 |
| `SessionEnd` | Yes | No | ClaudeのRun終了記録 |
| `InstructionsLoaded` | Yes | No | Claudeの命令ファイル読込監査 |
| `StopFailure` | Yes | No | Claude固有の停止失敗記録 |

Claude Codeにはさらに`Setup`、`UserPromptExpansion`、`MessageDisplay`、`PermissionDenied`、`TaskCreated`、`TaskCompleted`、`ConfigChange`、`CwdChanged`、Worktree、Elicitation等のイベントがある。これらはv0.1の共通コアには必須とせず、機能追加時にADRとfixtureを追加する。共通P0は`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreCompact`、`PostCompact`、`Stop`に限定する。

Codexでは、現在実行されるHook handlerは`type: "command"`だけである。`prompt`と`agent`は設定として解釈されるが実行されない。Claude Codeはcommand、HTTP、MCP tool、prompt、agent Hookをサポートする。

この差を吸収するため、irohaの共通コアはcommand Hookだけで成立させる。Claude固有機能はOptional Enhancementとして扱う。

Sources:

- [Claude Code: Hooks reference](https://code.claude.com/docs/en/hooks)
- [OpenAI: Codex Hooks](https://learn.chatgpt.com/docs/hooks)

### 3.3 SessionEndへ依存した要約は成立しない

Codexには現在`SessionEnd` Hookがない。Claude Codeの`SessionEnd`はデフォルトtimeoutが1.5秒であり、現在はHookごとの設定により全体予算を上限60秒まで増やせる。ただし強制終了やプロセスクラッシュを完全には捕捉できず、Codexとの共通性もないため、iroha v0.1は意図的に1.5秒の軽量な状態更新だけへ使用する。

したがって、セッション終了時に初めて全文要約する方式は採用しない。

採用する方式:

- Turnごと、または意味のある作業単位ごとに構造化Checkpointを保存する
- 現在動作中のClaude/Codex自身がMCP toolへ構造化payloadを渡す
- `Stop` Hookは、必要なCheckpointが欠けたときだけ一度継続を要求する
- `stop_hook_active`を確認し、継続ループを防ぐ
- Session summaryは複数Checkpointから集約できるようにする
- 次回`SessionStart`で未完了Runを検出し、interruptedとして回復する

### 3.4 transcriptは補助データであり、主要APIではない

Claude CodeはtranscriptをJSONLとして保存するが、各entryの形式は内部実装であり、バージョン間で変わるため直接解析スクリプトが壊れ得ると公式に明記している。CodexもHookへ`transcript_path`を渡すが、形式は安定したHookインターフェースではないとしている。

またClaude Codeのtranscript書き込みは非同期で、Hook発火時点では最新メッセージがまだ含まれない場合がある。`Stop`では`last_assistant_message`を使用すべきとされる。

設計判断:

- transcript parserをコア機能にしない
- raw transcriptをGitへコミットしない
- Hookの安定フィールド、MCP Checkpoint、Git、GitホスティングAPIを利用する
- transcript importは将来のbest-effort adapterに限定する

Sources:

- [Claude Code: Manage sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code: Hooks common input](https://code.claude.com/docs/en/hooks)
- [OpenAI: Codex Hooks common input](https://learn.chatgpt.com/docs/hooks)

### 3.5 Pluginは1リポジトリから両方へ配布できるが、Manifestは別

Claude Code Pluginは`.claude-plugin/plugin.json`を使用し、Codex Pluginは`.codex-plugin/plugin.json`を使用する。両方ともSkill、Hook、MCP serverを同梱できる。

Skill本体はOpen Agent Skills形式を中心に共通化できるが、ユーザーによる明示呼び出し構文は異なる。

| 操作 | Claude Code | Codex | 共通CLI |
|---|---|---|---|
| 初期化 | `/iroha:init` | `$iroha:init` | `iroha init` |
| 同期 | `/iroha:sync` | `$iroha:sync` | `iroha sync` |
| 検索 | `/iroha:search` | `$iroha:search` | `iroha search` |
| Checkpoint | `/iroha:checkpoint` | `$iroha:checkpoint` | `iroha checkpoint` |
| Dashboard | `/iroha:dashboard` | `$iroha:dashboard` | `iroha dashboard` |

Claude CodeではPlugin Skillが`plugin-name:skill-name` namespaceとなり、slash commandとして呼び出される。Codexでは`$`でSkillをmentionするため、同一のslash構文へ完全統一はできない。

Sources:

- [Claude Code: Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code: Skills](https://code.claude.com/docs/en/skills)
- [OpenAI: Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [OpenAI: Build skills](https://learn.chatgpt.com/docs/build-skills)

### 3.6 Codex Plugin Hookには明示的なtrustが必要

Codexのnon-managed command Hookは、定義のhash単位でユーザーが確認・信頼する必要がある。Pluginをinstallまたはenableしただけでは、同梱Hookは自動的に信頼されない。更新でHook定義が変わった場合は再確認対象になり得る。

irohaのonboardingでは次が必要になる。

- Plugin install後に`/hooks`を開く案内
- iroha Hookの用途と実行コマンドを表示
- Hookが無効でもCLI/Skill/MCPで最低限利用できるfallback
- 管理ポリシーでHookが禁止された環境を検出し、明示する

### 3.7 命令ファイルの読み込み仕様が異なる

Codexは`AGENTS.md`を、global、repository root、current working directoryまで階層的に読み込む。近い階層の指示が後ろに連結され、デフォルト合計上限は32KiBである。

Claude Codeは`CLAUDE.md`を読み、`AGENTS.md`を直接の標準ファイルとしては扱わない。ただし`CLAUDE.md`から`@AGENTS.md`をimportできる。Claude Codeは`.claude/rules/*.md`とpath-specific ruleもサポートする。

irohaは`init`/`sync`時に次を探索して、出典付き知識候補として取り込む。

- `AGENTS.md`, `AGENTS.override.md`
- `CLAUDE.md`, `CLAUDE.local.md`
- `.claude/rules/**/*.md`
- ユーザー指定の`docs` glob

Claude Codeの`InstructionsLoaded`は追加の監査情報として利用するが、Codexとの共通要件にはしない。

Sources:

- [OpenAI: Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Code: CLAUDE.md and memory](https://code.claude.com/docs/en/memory)

### 3.8 Hookは完全なセキュリティ境界ではない

Codexの公式仕様では、hosted toolsはlocal function-tool Hook pathを通らず、一部のspecialized tool pathもopt outできる。Claude Codeでは、ユーザーが`@file`で参照した内容はRead tool callを発生させないため、`PreToolUse`では捕捉できない。

したがって、irohaは次の2種類を区別する。

1. Advisory rule: 検索してエージェントへ注入する自然言語のガイダンス
2. Guardrail rule: path、tool、command等を機械判定でき、HookまたはCIで検査可能なルール

厳格なセキュリティ・品質要件は、Git branch protection、CI、既存permission system等と組み合わせる。

## 4. 製品戦略への影響

### 採用する価値仮説

> AIコーディングエージェントの「記憶量」ではなく、チームの開発知識を、複数エージェント横断・出典付き・承認付き・再利用可能にすることに価値がある。

### 避ける訴求

- Claude/Codexが何も記憶できない
- irohaを入れれば独自実装を100%防止できる
- transcriptを完全かつ恒久的に解析できる
- Hookだけで全Toolを強制制御できる
- 個人の開発速度を正確に採点できる

### 強める訴求

- Cross-agent Engineering Memory
- Human-governed knowledge
- Issue → Session → PR → Review → Ruleの学習ループ
- Local-first / Git-native / self-hosted
- 日本語・英語・コードを横断する検索
- 組織知の可視化とオンボーディング

## 5. 公式仕様に基づく制約一覧

| 制約 | 影響 | 対応 |
|---|---|---|
| Codexに`SessionEnd`がない | 終了時一括処理不可 | Turn Checkpoint + 次回復旧 |
| Codexはcommand Hookのみ | LLM Hookの共通利用不可 | 共通コアをcommand Hookで実装 |
| Claude SessionEndが短時間 | 重い処理不可 | status更新のみ |
| transcriptが不安定 | parser保守コスト・破損 | コア依存を禁止 |
| Hookが無効化され得る | 自動記録が欠ける | Skill/CLIによる手動fallback |
| Codex Hookにtrustが必要 | onboarding摩擦 | init doctorと明示案内 |
| メモリはローカル | チーム共有不可 | Git管理`.iroha/` |
| 命令は強制設定ではない | 逸脱の可能性 | Guardrail/CIとの分離 |
| Embedding APIが未設定 | 意味検索不可 | FTS fallback |
| Git pullだけではPR/Reviewを取得できない | 関係が欠ける | Optional forge API sync |

## 6. 調査結果から確定した設計判断

1. raw transcript parserをMVPに含めない
2. Turn/Checkpoint中心のSession Lifecycleを採用する
3. Claude/CodexそれぞれにManifest、Hook config、MCP configを持つ
4. Skill内容、TypeScript core、MCP server、CLI、DB、Dashboardは共有する
5. 承認済みデータだけを`.iroha/`へ公開する
6. local DBは再構築可能な派生データとする
7. Claude固有イベントはOptional adapterとする
8. Advisory ruleとEnforceable guardrailをデータモデルで区別する
9. native memoryとは競合せず、必要に応じて共存する
10. 個人監視ではなく知識フローを可視化する

## 7. 調査後に確定した実装ベースライン

| 項目 | 決定 |
|---|---|
| Node / package manager | Node.js `>=24 <25`、pnpm 11.14.0、Turborepo 2.10.5 |
| TypeScript | 7.0.2、ESM-only |
| Claude Code | 最低2.1.198、調査時fixture基準2.1.214 |
| Codex | 最低・調査時fixture基準0.144.5。pre-1.0のためcapability detection必須 |
| 対応Surface | Claude Code TerminalとCodex CLIを正式対象。IDE/DesktopはPreview、Web/Cloudは対象外 |
| Tier 1 OS | macOS 14 arm64/x64、Ubuntu 22.04 arm64/x64、Windows 11 x64、WSL2 |
| Embedding | 任意のVoyage `voyage-4`、1024次元。ゼロ設定はFTS+Graph |
| Forge | Git metadataをP0、GitHubを最初のP1 provider、GitLabはport/fixtureのみ |
| 配布 | `@iroha-labs/iroha`、GitHub Releases、Claude/Codexの各marketplace manifest |

厳密なversion、OS、package、feature detectionは [Compatibility Contract](./implementation/compatibility.md)、Hookのイベント・入出力・timeoutは [Hook Contract](./implementation/hooks-contract.md) を正本とする。

## 8. Primary Sources

### Claude Code

- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Create plugins](https://code.claude.com/docs/en/plugins)
- [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Manage sessions](https://code.claude.com/docs/en/sessions)
- [Data usage](https://code.claude.com/docs/en/data-usage)
- [Monitoring](https://code.claude.com/docs/en/monitoring-usage)

### Codex

- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Memories](https://learn.chatgpt.com/docs/customization/memories)
- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)

### Storage / search / embeddings

- [libSQL](https://docs.turso.tech/libsql)
- [libSQL vector search](https://docs.turso.tech/features/ai-and-embeddings)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [Voyage AI Embeddings](https://docs.voyageai.com/docs/embeddings)
- [pnpm Workspaces](https://pnpm.io/workspaces)
