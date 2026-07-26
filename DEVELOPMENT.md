# iroha 開発ガイド / 技術スタック全図鑑

iroha の開発に使っている技術を「何か / iroha での役割 / いつ使うか（トリガー） / コマンド」で網羅した早見表。コントリビューターがこのリポジトリのツールチェーン全体を把握するための入口。

手順（セットアップ、ダッシュボードの起動、e2e、PR の出し方）は [CONTRIBUTING.md](./CONTRIBUTING.md) が担当する。本書は「何を使っていて、なぜそれか」を扱う。

正本は `CLAUDE.md` + `.claude/rules/` + `docs/`（[architecture.md](./docs/architecture.md) と [contracts/](./docs/contracts/)）。本書は横断的な早見表であり、細部が食い違ったら正本が優先。

## 0. 設計思想（なぜこの構成か）

- **ローカルファースト**: クラウド・常駐デーモン・外部同期なし。libSQL は「捨てて再構築できるローカル索引」であって正本ではない。正本は Git 管理された `.iroha/`。
- **ポート & アダプタ**: 最内核の `@iroha/domain` は SDK 型・FS・DB 実装から独立（依存は Zod のみ）。`@iroha/core` はその上のユースケース層で、storage/git/canonical 等をポート経由で使う。プラットフォーム依存はアダプタに閉じ込める。
- **境界で必ず検証**: 外部入力（ユーザー・API・サブプロセス・ファイル）は Zod で検証してから内側へ。例外は境界を越えない（`Result<T,E>`）。
- **KISS / YAGNI 優先**: 抽象化は 3 回目の重複が現実に起きてから。将来仮定でオプションや層を足さない。
- **多層防御**: セキュリティスキャナも Git フックも「1 つが漏らしても別が拾う」よう重ねる。

## 1. 言語・ランタイム

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **TypeScript 7.0.2**（Corsa / native compiler） | 全コードの言語。`tsc` は**型チェック専用**（`noEmit`）。実行コードの emit は tsdown が担当 | 型を書く/直すたび。`tsc` は CI と `pnpm typecheck` で走る。ビルド時の `WARN "experimental API"` は既知（native compiler が未安定 API のため） |
| **Node.js `>=24 <25`** | 唯一サポートするランタイム。ESM のみ（`"type": "module"`） | 常時。相対 import は `.js` 拡張子必須（NodeNext の file-extension substitution） |
| **mise**（`mise.toml`） | ローカルの Node メジャーを CI に合わせて固定（`node = "24"`）。pnpm は corepack 管理なので mise では固定しない | clone 直後 `mise install`。`mise.toml` 変更時は `mise trust` を再要求される（仕様、エラーではない） |

## 2. モノレポ・ビルド・タスク実行

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **pnpm workspace**（v11、`pnpm-workspace.yaml`） | 20 パッケージのモノレポ管理。ワークスペース依存は `workspace:*` | 依存の追加/更新時 |
| ├ **strict catalog**（`catalogMode: strict`） | 依存をカタログに集中ピン留め。`package.json` では `"catalog:"` で参照。バージョンの単一情報源 | 依存追加時は必ずカタログにピン留め→`"catalog:"` 参照。**例外**: turbo は `compatibility.md` の表が「exact in root devDependencies」を指定しているためカタログ外の直接ピン（`"turbo": "2.10.5"`） |
| ├ **公開直後版のガード** | 実際に効いているのは Renovate の `minimumReleaseAge: 3 days`（`.github/renovate.json`）。pnpm 側の `minimumReleaseAge` は**未設定**で、`minimumReleaseAgeExclude` リストだけが残置＝手で足した新しすぎる依存を install が弾くことはない | 新規依存は数日以上枯れた版を自分で選ぶ（自動では止まらない） |
| └ **overrides** | 上流に in-range 修正が無い transitive 脆弱性を強制パッチ（例: `fast-uri`, `js-yaml@5.2.1`） | osv-scan が transitive CVE を出し、上流未修正のとき |
| **turbo**（`turbo.json`） | タスクのキャッシュ付き並列オーケストレーション。依存辺は `build: ^build` と、`typecheck`/`test`: **上流の `build`**（同名タスクの上流ではない）。`lint` は依存辺なしで全パッケージ並列 | `pnpm lint` 等が内部で `turbo run` を呼ぶ。キャッシュヒットで `>>> FULL TURBO` |
| **tsdown**（rolldown ベース） | 実行コードのビルド（`dist/*.mjs` + `.d.mts`）。tsconfig の `paths` を自動解決 | `pnpm build`。プラグイン配布バンドルは `deps.alwaysBundle:[/^@iroha\//]` でワークスペースのみ inline |

## 3. コード品質・Lint・フォーマット

| ツール | 何か / iroha での役割 | いつ使う（トリガー） | コマンド |
|---|---|---|---|
| **Biome 2.5.4** | Lint + フォーマッタ（ESLint+Prettier 相当を 1 バイナリ）。パッケージ間 import 境界を `noRestrictedImports` で機械強制、`interface`/named export/kebab-case ファイル名等も強制 | コード変更の都度。CI と pre-commit | `pnpm lint`（`turbo run lint`）/ `pnpm format`（`biome format --write .`） |
| **sherif 1.13** | Rust 製のモノレポ `package.json` 整合 linter（依存キー順、多重バージョン等）。`-f` で自動修正 | 任意の `package.json` に依存を足/消/並べ替えした後 | `pnpm lint:packages` |
| **knip 6.29** | 未使用ファイル・未使用（dev）依存・未使用 export を検出（`knip.json`）。ハード CI ゲートではなくレビュー時チェック | 機能や caller を消した後、依存棚卸し時。false-positive は `knip.json` で設定（消さない） | `pnpm knip` |
| **taze 19** | 依存アップグレードの対話的確認（`-r` recursive・catalog 対応）。**報告のみ**、書込みは `-w` | ローカルで更新可能なものを見たいとき（定常更新は Renovate 側） | `pnpm deps:check` |

## 4. Git フック・コミット規約

| ツール | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **lefthook 2.1**（`lefthook.yml`） | Git フックランナー。pre-commit（merge-conflict / secret-scan / typecheck / biome / markdownlint）、commit-msg（commitlint）、pre-push（test / build） | commit / push の都度自動。`--no-verify` でスキップしない方針 |
| **commitlint 21** + **czg**（cz-git） | Conventional Commits 強制。サブジェクトは**100 文字以内**。czg は対話的にメッセージ生成 | commit 時に自動検証。`pnpm cz` で対話生成（`git commit -m` も可） |
| **gitleaks**（CI ゲート、pre-commit は任意） | コミット済みシークレット検出（entropy + パターン）。pre-commit は常に走る素の grep に加え、**ローカルに gitleaks が入っていれば** `--staged` でも検査する二層。未インストール時は警告のみでブロックしない（`brew install gitleaks` 推奨）＝正本ゲートは CI の `secrets-scan` | commit / push・CI の都度 |
| カスタムフック `.claude/hooks/check-path-safety-diff.sh` | `*paths*.ts`/`*credential*.ts` に新規 `path.resolve/join/normalize` が増えたら手動承認を要求（決定的バックストップ） | git push 時（該当ファイルを触ったとき） |

## 5. テスト

| ツール | 何か / iroha での役割 | いつ使う（トリガー） | コマンド |
|---|---|---|---|
| **vitest 4.1** | ユニット/統合テスト。設定ファイルは基本置かない（CLI デフォルト）。既定タイムアウト**5000ms** | 変更の都度。重いテストは `it(name, {timeout}, fn)` で明示延長 | `pnpm test`（`*.contract.test.ts` 除外） |
| **fast-check 4.9** | プロパティベーステスト。生成入力 + 失敗を最小反例に shrink | parse↔serialize 往復・参照実装との一致・redaction の網羅など「広い入力空間で成り立つ不変条件」。`numRuns`/`seed` を明示し決定的に | 例: `credential-redaction.test.ts` |
| **Playwright 1.61**（`apps/e2e`） | 実 `iroha dashboard` を起動しブラウザで承認ジャーニー + CSP 違反ゼロを検証 | **opt-in**（CI verify マトリクス非組込）。UI/CSP/バンドルに関わる変更時 | `pnpm test:e2e`（要 `playwright install chromium`） |
| 契約テスト（`test:contracts`） | Zod スキーマと `schemas/*.schema.json`（AJV）を同一 fixture で突き合わせ、accept/reject の一致を保証 | ドメインスキーマ（`packages/domain/src/schemas/*` or ルートの `schemas/*.json`）を触ったとき | `pnpm test:contracts` |

**テスト方針**: 外部依存（実サブプロセス・実 FS）はモックしない（`packages/git` は実 tmp git repo を作る）。「X が起きる」と主張する前に、修正前コードで**赤くなる**再現テストを書く。

## 6. バリデーション・契約・型

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **Zod 4.4** | 全境界の検証。`.safeParse()` のみ（`.parse()` は throw するので禁止）→ `Result` に包む。`z.strictObject`/`z.discriminatedUnion`/`z.iso.datetime()` | 外部入力を受ける境界すべて。スキーマは `<name>Schema`。JSON Schema のミラーは Zod と `schemas/*.json` を**同一コミットで両方**更新 |
| **JSON Schema + AJV** | 契約ドキュメントの機械可読正本（`schemas/*.schema.json`）。Zod は実行時、JSON Schema は契約 | 上記契約テストで乖離を検出 |
| **ts-pattern 5.9** | 判別可能ユニオンの網羅マッチ。`match(x).with({kind},…).exhaustive()` で「新 variant 追加漏れ」を**コンパイルエラー**化 | renderer/dispatcher/normalizer 等、全 variant を扱う所。単純な `default` 付き `switch` はそのまま |
| **Result<T,E>**（`@iroha/domain`） | `ok`/`err`/`isOk`/`isErr`。公開関数は境界を越えるとき必ず Result を返す | 全パッケージ境界。`IrohaError.code` は `ERROR_CODES` から選ぶ。message/details に生パス・生値・資格情報を入れない |

## 7. データ層

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **libSQL**（`@libsql/client` 0.17） | ローカル SQLite 互換索引（`<git rev-parse --git-path iroha>/index.db`）。**捨てて再構築可能**、承認済み知識の唯一の正本ではない | 検索・グラフ・セッション索引。パラメータ化 SQL のみ（文字列連結禁止）。パスは必ず git に解決させる（linked worktree や separate git dir では `.git/iroha` とは限らない） |
| **前方専用マイグレーション**（`migrations/*.sql`） | スキーマ進化。rebuild テストで再構築可能性を保証 | スキーマ変更時。前方専用（後方互換シムを作らない） |
| **FTS**（libSQL 全文検索） | 語彙検索アーム。識別子/path は AND、自然文は OR にクエリ種ルーティング | 検索の lexical 経路。索引は 2 本立てで、`unicode61` が英単語・識別子、`trigram` が CJK と部分一致を担当（日本語は分割せずそのまま引ける） |

**Windows 注意**: WAL モードの close 後ロックで `EBUSY` が起きるため Windows は CI verify マトリクスから除外（`.claude/rules/windows-ci-compat.md`）。

## 8. API・ダッシュボード

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **Hono 4.12** | ローカルダッシュボード API（loopback 限定）。cookie セッション認証 + anti-CSRF | `packages/api`。全 mutation は `X-Iroha-Request:1` 必須 |
| **@hono/zod-openapi 1.5**（+ 内包 zod-validator） | 各ルートを Zod リクエストスキーマで宣言 → 検証 + **OpenAPI 3.1** 生成（`GET /api/doc`）。詳細規約は `typescript-conventions.md`「HTTP API routes」 | ルート追加/変更時。ハンドラは `never` 返し（動的ステータス envelope のため）、query は `union([string,array])`+`firstOf`、mutation は `withCsrf` でヘッダ宣言 |
| **@hono/node-server 2.0** | Hono の Node アダプタ（サーバ起動） | ダッシュボード起動時 |
| **React 19 + Vite 8** | SPA（`apps/dashboard`）。`moduleResolution: bundler` | UI 実装。ビルドは vite |
| **Tailwind v4 + shadcn/ui（Base UI）** | デザインシステム。**strict CSP `style-src 'self'`** 下で動く（`disableStyleElements`）。ブランドは「生成り紙 3 層 + 三色リング」 | UI コンポーネント追加時。`<style>` を注入するライブラリ（sonner 等）は CSP 非互換で**禁止**。詳細は `dashboard-shadcn-and-csp.md` / `brand-and-design.md` |
| **TanStack Query 5** / **React Router 7** | データ取得キャッシュ / ルーティング | SPA のデータ・画面遷移 |
| **Recharts 3** / **@xyflow/react 12** / **cmdk** / **lucide-react** | チャート / グラフ可視化 / コマンドパレット / 細線アイコン | 各 UI 部品。色は `var(--chart-N)` 経由（CSP 対策で ChartStyle 非注入） |

**API クライアント**: SPA は素の `fetch`（`apps/dashboard/src/api/client.ts`）で envelope `{ok,data,meta}` を読む。Hono RPC 型は使っていない（`AppType` は export のみ）。

## 9. MCP（Model Context Protocol）

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **@modelcontextprotocol/sdk 1.29** | Claude Code / Codex へ検索等のツールを公開。**stdio トランスポート**（HTTP transport は不使用＝該当脆弱性に到達しない） | `packages/mcp`。ツールは `dispatchTool` 経由、承認は human 経路（`approveCandidate`） |

## 10. Forge（GitHub 連携、WP-12）

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **octokit GraphQL スタック**（`@octokit/core` + retry + throttling + paginate-graphql） | GitHub Issue/PR/レビューを正規化イベントとして取り込む | `iroha sync` の forge 経路（**fail-open**: forge 失敗は canonical sync を落とさない） |
| **graphql-codegen**（typed-document-node） | `@octokit/graphql-schema` から**オフライン**で型付きクエリ生成（`documentMode:"string"`） | GraphQL クエリの型を変えたとき（codegen 実行） |

## 11. 埋め込み・検索

| 技術 | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **Voyage `voyage-4-large`**（1024 次元） | ベクトル埋め込み。**失敗時は語彙検索へ degrade** | 検索のベクトルアーム。API 不通でも lexical で動く |
| **録画ベクトル方式** | `embeddings.recorded.json` を replay してオフライン決定評価（Recall@10 等） | eval ゲート。再録画は `IROHA_RECORD_EMBEDDINGS=1`（要 `VOYAGE_API_KEY`） |
| **RRF ハイブリッド**（k=60、重み 1.0/0.9/1.1） | 語彙 + ベクトル + グラフの融合ランキング | 検索の統合。現行ベストプラクティスとして維持 |

## 12. セキュリティスキャナ（CI、`.claude/rules/ci-security.md`）

| スキャナ | カバー範囲 | ゲート? |
|---|---|---|
| **osv-scanner** | 依存の既知 CVE（lockfile 由来） | **Yes**（fail-on-vuln） |
| **gitleaks** | コミット済みシークレット（履歴全体、entropy+パターン） | **Yes** |
| **CodeQL** | JS/TS の SAST（dataflow・injection） | No（Security タブへ） |
| **Trivy** | 依存+シークレット+**IaC/設定ミス** | No（advisory） |
| **Semgrep**（`.semgrep/`、独自ルール） | iroha 固有不変条件（`zod .parse` 禁止 / `{...process.env}` spread 禁止 / `eval` 禁止） | **Yes**（`--error`） |
| **secretlint** | canonical 書込み前のシークレット検査（`secret-scan.ts`、ランタイム id 解決） | 書込み境界 |

- gating（osv/gitleaks/semgrep）は merge をブロック。CodeQL/Trivy は overlap ゆえ advisory。
- ローカルは gitleaks のみ、他は CI 専用（重い DB/バイナリ）。「ローカル緑 ≠ CI 緑」。
- 第三者 action は immutable SHA ピン、各 job 最小権限。

## 13. パッケージング・リリース

| ツール | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **publint 0.3** | 公開パッケージの packaging 正当性（exports/files/bin、ESM/CJS 条件） | packaging（`build-release.ts`/plugin `package.json`/exports/bin）を触ったとき。`pnpm check:package` |
| **attw**（@arethetypeswrong/cli 0.18） | 型解決可能性チェック。iroha 公開物は**CLI**なので "no types" は想定内（exit 0） | 同上。`pnpm check:package` |
| **size-limit 13** | ダッシュボードバンドルの**brotli** サイズをゲート（`.size-limit.json` の上限は 320kB JS / 18kB CSS。現状は ~295kB / ~15kB） | UI 依存/重い import を足したとき。CI `size` job。`pnpm size` |
| **changesets 2.31** | バージョン/CHANGELOG 管理 | リリース準備時。`pnpm changeset` |
| **npm provenance** | `release.yml` の `workflow_dispatch`（`publish:true`）で `@irohalabs/iroha` を publish（SBOM は組込 `npm sbom`） | **人間ゲート**（既定は dry-run）。認証は OIDC trusted publishing で `NPM_TOKEN` は存在しない／作らない |

**公開物の実体**: `@iroha/plugin` を `@irohalabs/iroha` として publish。bin-only CLI（exports/types を剥がす）。`build-release.ts` が name 書換え・workspace 依存 drop・`catalog:`→具体版解決・migrations/dashboard/skills 同梱。

## 14. ドキュメント・パース

| ツール | 何か / iroha での役割 | いつ使う（トリガー） |
|---|---|---|
| **markdownlint-cli2 0.23** | Markdown lint（`docs/architecture.md` と `docs/contracts/**` は除外＝メンテナ向け参照） | `.md` 変更時。pre-commit + CI docs-lint。`pnpm lint:md` |
| **typos**（CI 専用） | タイポ検査。ツール名がタイポに見えるもの（`sherif`→sheriff 等）は `_typos.toml` に許可登録 | docs-lint job。ローカル未導入 |
| **mdast-util-from-markdown** | 構造化 Markdown の正しいパース（naive な `#` 正規表現はコードフェンス内を誤検出する） | canonical 文書等の Markdown 検証 |

## 15. CI レビューボット（`.claude/rules/ci-review-bots.md`）

| ボット | 観測方法 | トリガー |
|---|---|---|
| **Greptile**（**現在 disabled**） | 有効時は CI status check「Greptile Review」（advisory・**findings 有無に関わらず pass**）+ Summary/inline コメント。P0/P1/P2 バッジ | 現状は動かないので「Greptile Review」チェックを待たない（永久に現れず post-push の確認が止まる） |
| **Codex**（`chatgpt-codex-connector[bot]`） | **CI 非観測**。PR リアクション 👀（レビュー中）/ 👍（完了・問題なし）/ 👍消滅（完了・問題あり）+ 投稿レビュー | **PR open のみ自動**。再レビューは `@codex review [for security regressions]`。rate-limited なので claude が要否判断（既指摘の修正だけなら再依頼しない） |

**規律**: push 後は CI が全項目 pass するまで見届け、Codex が 👀 のままマージしない。全 finding（`<details>` 折り畳み含む）を読み、INVALID は再現で実証。修正 push 後はスレッドを resolve。

## 16. ドメイン設計パターン

- **fresh-context レビュー**: production/security 変更は、変更理由を知らない fresh subagent（`security-diff-reviewer` 等）に独立レビューさせ確証バイアスを排除。`self-review` / `iroha-review` スキルが束ねる。
- **diminishing returns**: 修正の反復が「リスク低減」でなく「新リスク生成」に転じたら、パラメータ弄りを止め一次ソースで root cause 調査 → 収束しなければスコープを人間と固定し、その制約が効くコード/設定のコメントに記録。
- **fail-open / fail-closed**: hook 内部失敗は fail-open（承認済み Guardrail が明示 deny する場合を除く）。canonical 書込み前の redaction は fail-closed。

## 17. 主要コマンド早見表（トリガー別）

| やりたいこと | コマンド |
|---|---|
| WP 完了前の必須検証 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` |
| スキーマを触った | `pnpm test:contracts` |
| `package.json` の依存を弄った | `pnpm lint:packages`（sherif） |
| 機能/caller を消した・棚卸し | `pnpm knip` |
| 独自不変条件チェック | `pnpm semgrep`（要 `pipx install semgrep`） |
| packaging を触った | `pnpm check:package` |
| UI 依存/重い import を足した | `pnpm size` |
| UI/CSP/バンドルに関わる変更 | `pnpm test:e2e`（要 chromium） |
| ダッシュボードをローカルで見る | `pnpm dashboard`（or `dashboard:api` / `dashboard:web`） |
| 依存の更新確認 | `pnpm deps:check`（taze、報告のみ） |
| 対話的コミット | `pnpm cz` |
| フォーマット一括 | `pnpm format` |

## 18. パッケージ依存境界（`compatibility.md` §4、biome が機械強制）

`domain` ← 全パッケージが依存可（最内核）。`core` → `domain`/`storage`/`canonical`/`git`/`search`/`config`/`adapter-*`/`forge*`。`api` → `core`。`cli`/`mcp`/`plugin` → 上位。`forge-github` → `forge` → `domain`。禁止 import を書くと `pnpm lint` がエラー（許可先も表示）。§4 を変えるときは `biome.json` の override も同一コミットで更新。

技術を追加・置換したら、この表も同じ PR で更新すること。
