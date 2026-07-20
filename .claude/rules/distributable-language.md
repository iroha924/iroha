# 配布物の言語: デフォルト英語

iroha の**配布物・成果物はデフォルト英語**。日本語は「提供する追加ロケール」であって既定ではない。会話（この repo での開発チャット）は日本語で構わないが、コードに残るもの・利用者に届くものは英語を既定にする。

## 対象（英語を既定にする）

- プロダクト名 / CLI 名 / パッケージ名（`iroha`, `@iroha-labs/iroha`）
- CLI の出力・エラーメッセージ・ヘルプ
- ソースコードのコメント・docstring・識別子
- `docs/`・`README`・`.github/` テンプレート・contract ドキュメント
- canonical テンプレート（`.iroha/` に書き出す見出し等）
- **dashboard UI の既定ロケール**（`apps/dashboard` の i18n フォールバックは `en`）
- `iroha init` が書き出す `config.yaml` の `default_language`（既定 `en`）

## 日本語の位置づけ

- dashboard は日英のメッセージカタログを持ち、`ja` を**選択可能**にする（`config.default_language: ja` の repo は起動時に日本語で表示してよい）。
- 日本語対応を削るのではなく、「既定は英語、日本語は opt-in」を保つ。

## spec との差分

`docs/product/implementation/dashboard-api.md` §8 の散文は "Japanese is the default UI locale" と書くが、これは**本ルールで上書き**される（英語既定）。`iroha init` は既に `default_language: "en"` を書いており、コードと本ルールが正。prose 側の記述は誤り（将来 doc 更新時に是正する）。

## 関連

- 会話は日本語可・成果物は英語、という運用の背景は user メモリ `iroha-english-artifacts` と同じ。
