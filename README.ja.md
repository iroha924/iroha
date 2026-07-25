<p align="center">
  <img src="apps/dashboard/public/iroha-lockup-horizontal.svg" alt="iroha" width="320">
</p>

<p align="center">
  <a href="./README.md">English</a> | 日本語
</p>

<p align="center">
  <a href="https://github.com/iroha924/iroha/actions/workflows/ci.yml"><img src="https://github.com/iroha924/iroha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24%20%3C25-6E7B57" alt="Node >=24 <25">
  <img src="https://img.shields.io/badge/license-Apache--2.0-6F675A" alt="License Apache-2.0">
</p>

**iroha** は、Claude Code と Codex のためのローカルファースト Engineering Memory Graph です。エージェントとのセッションで生まれた決定・ルール・積み重ねてきた教訓を、検索できて Git で管理される知識ベースに変え、チーム全体で共有します。しかも、人間が承認するまで何ひとつ書き込まれません。

承認された知識は、出どころ（元になったセッション・Pull Request・コミット・レビュー）を必ず保持します。エージェントはその記憶を MCP 経由で検索できるので、次のセッションは「なぜこのコードがこうなっているのか」を最初から把握した状態で始まります。

## iroha を使う理由

- **エージェントが忘れなくなる。** あるセッションで捉えた決定や規約が、出どころ付きで次のセッションに引き継がれます。Claude Code と Codex をまたいでも同じ記憶を共有します。
- **常に人間が介在する。** エージェントが出すのは知識の「候補」です。残す価値があるものだけをあなたが承認します。承認された知識は `.iroha/` 配下の正準 Markdown になり、Git にコミットされてチームで共有されます。
- **ローカルファースト、既定でプライベート。** クラウドアカウントも、テレメトリも、外部への送信もありません。生のプロンプトやトランスクリプトが知識ベースに書き込まれることはありません。唯一の任意の外部通信は埋め込み生成だけで、これは自分の鍵で有効にします。
- **設定ゼロで動く検索。** 全文検索とグラフ検索は最初から使えます（日本語などの CJK テキストにも対応）。埋め込み用の鍵を足せばセマンティック検索が有効になり、鍵がなければ全文検索に切り替わって、失敗はしません。

iroha は監視ツールでも生産性ランキングツールでもなく、ホスティング型のバックエンドも持ちません。あなた自身が所有する記憶のグラフです。

## 動作要件

- **Node.js** `>=24 <25`
- **Git** — iroha は Git リポジトリ上で動作します
- **Claude Code** `>=2.1.198` と **Codex** `>=0.144.5` のいずれか、または両方

## インストール

iroha は `@iroha-labs/iroha` という 1 つの npm パッケージとして配布され、`iroha` バイナリを提供します。このバイナリが CLI・ライフサイクルフック・MCP サーバーのすべての実体なので、まずこれを入れることが唯一必須の手順です。

```bash
npm install -g @iroha-labs/iroha
```

任意の Git リポジトリの中で、次を実行します。

```bash
iroha init      # .iroha/ とローカルインデックスを作成（再実行しても安全。結果はコミットする）
iroha doctor    # Node・Git・検出されたエージェント・データベース機能を確認
```

`iroha` CLI（`init | sync | search | dashboard | doctor`）は単体で完結して動きます。以下のプラグインは、その上にエディタ連携を追加するものです。

## エージェントの設定

プラグインは、iroha のスキル・ライフサイクルフック・MCP サーバーをエージェントに登録します。どちらのプラグインもグローバルに入れた `iroha` バイナリを呼び出すので、上のインストールを先に済ませておいてください。

### Claude Code

```text
/plugin marketplace add iroha924/iroha
/plugin install iroha@iroha
```

スキルは `/iroha:init`、`/iroha:sync`、`/iroha:search`、`/iroha:checkpoint`、`/iroha:dashboard`、`/iroha:doctor` として使えます。

### OpenAI Codex

```bash
codex plugin marketplace add iroha924/iroha
```

その marketplace から、Codex のバージョンに応じたプラグイン導入手順（Codex CLI の `/plugins`）で `iroha` プラグインをインストールします。Codex はプラグインのフックを自動では信頼しません。`/hooks` を実行して明示的に信頼してください。それまでの間も MCP サーバーと CLI は動作します。Codex のスキルは `$init`、`$sync` のように呼び出します。

インストール・更新・アンインストールの詳細（Codex のフック信頼フローを含む）は [docs/install.md](./docs/install.md) にまとめてあります。

## クイックスタート

プラグインを設定したら、流れは「いつも通り作業して、あとで整える」だけです。

```bash
# 1. いつも通りエージェントと作業します。iroha のフックがセッションを観測し、
#    覚えておく価値のあること（決定・ルール・教訓）が生まれると、エージェントが
#    MCP サーバー経由でそれを候補として提案します。

# 2. ローカルダッシュボードで候補をレビューして承認します。
iroha dashboard
#    → http://127.0.0.1:<port>/#token=… が開きます。残す価値があるものを承認します。

# 3. 承認された知識は .iroha/ 配下の正準 Markdown になります。コミットします。
git add .iroha && git commit -m "chore: approve knowledge"

# 4. いつでも記憶を検索できます（エージェントは MCP 経由、あなたは CLI から）。
iroha search "なぜ repository パターンを使うのか"
```

リポジトリを clone したチームメンバーは、`iroha init` の後に `iroha sync --rebuild` を実行すると、コミット済みの `.iroha/` からローカルインデックスを再構築できます。

## 承認ダッシュボード

`iroha dashboard` は、ローカルの単一オリジンアプリを 1 つの loopback ポートで配信し、ブラウザにワンタイムの launch token を渡します。ここで知識の候補をレビューし、各項目の出どころと関連を確認して、承認または却下します。承認は人間の操作であり、ダッシュボードと CLI にだけ存在します。エージェントの手は届きません。ダッシュボードは loopback にのみバインドし、マシンの外には何も公開しません。

## 設定

`iroha init` は `.iroha/config.yaml` を書き出します。ここに記録するのは**環境変数の名前**であって、秘密の値そのものではありません。値は実行時に環境から読み取られ、保存も、ログ出力も、コミットもされません。

| 環境変数 | 用途 | 必須 | 未設定のとき |
|---|---|---|---|
| `VOYAGE_API_KEY` | Voyage によるセマンティック（ベクトル）検索の埋め込み | いいえ | 全文検索とグラフ検索のみに切り替わる |
| `GITHUB_TOKEN` | GitHub forge 連携（Pull Request・レビュー）の同期 | いいえ | forge 連携が無効になるだけ |

`config.yaml` の主な設定は次のとおりです。

- `default_language` — `en`（既定）または `ja`。ダッシュボードの起動時ロケール。
- `canonical.require_human_approval` — `true` のままにして、レビューなしで何も正準化されないようにします。
- `privacy.*` — プロンプトやトランスクリプトの内容が正準ファイルに到達しうるかどうか（既定は無効）。

## 仕組み

1. **アダプタが両方のエージェントを正規化します。** Claude Code と Codex のセッションは同じドメインイベントになり、1 つの記憶グラフが両方を扱います。
2. **知識は作業の途中で捉えます。** セッション終了時の要約ではなく、Turn/Checkpoint のライフサイクルで捉えます（Codex にはセッション終了フックがないためです）。
3. **候補は出どころを持ちます。** 提案される決定・ルール・洞察は、それぞれ元のソースと関連項目にひも付きます。
4. **人間が承認します。** 承認された知識は `.iroha/` 配下の正準 Markdown に書き込まれ、コミットされます。これがチームで共有する信頼できる情報源です。
5. **ローカルの libSQL インデックスが検索を支えます**（全文は常に、セマンティックは鍵があるとき）。このインデックスは使い捨てで、いつでも `.iroha/` から再構築できます。承認済み知識の唯一の情報源になることはありません。

## よくある質問

**何かがマシンの外に出ますか？** いいえ。iroha はローカルファーストで、クラウドアカウントもテレメトリもありません。唯一の任意の外部通信は Voyage の埋め込み生成で、これは自分の `VOYAGE_API_KEY` で有効にします。

**埋め込み用の鍵がありません。** それでも検索は使えます。全文検索とグラフ検索は設定ゼロで動き、日本語などの CJK クエリにも対応します。セマンティック検索は任意の追加機能です。

**知識はどう保存されますか？** `.iroha/` 配下の、Git で管理される素の Markdown です。ほかのソースと同じように読み・差分確認・レビューができます。`.git/iroha/` 配下の libSQL インデックスは使い捨てのキャッシュです。

**インデックスを再構築するには？** `iroha sync --rebuild` です。clone 直後は先に `iroha init` を実行してください。

**名前の由来は？** *いろは* は、各仮名を一度ずつ使う古い日本語の歌の冒頭で、転じて「基本・初歩」を意味します。

## 開発に参加する

コントリビュートを歓迎します。開発環境とワークフローは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。製品仕様の全体は [docs/product/](./docs/product/) にあります。

## セキュリティ

フックによる強制はガードレールであって、完全なセキュリティ境界ではありません。厳密な強制は CI が担います。脆弱性の報告は、公開の issue ではなく [security advisory](https://github.com/iroha924/iroha/security/advisories/new) からお願いします。

## ライセンス

[Apache-2.0](./LICENSE) © iroha labs
