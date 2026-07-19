---
paths:
  - "packages/*/src/**/*.ts"
---

# Path traversal / symlink safety

WP-02(`packages/git/src/paths.ts`)で同じ欠陥クラスを4回作り込んだ末に確立したルール。パス検証・symlink解決・リポジトリ境界チェックを書く/直すときは必ず適用する。

## 核心invariant: symlinkを解決する前に `..` を字句的に畳まない

`path.resolve()`/`path.join()`/`path.normalize()` は、実際のファイルシステムを見ずに文字列operationとして `..` を畳む。symlinkを含むパスでこれをやると、`link/../secret.txt`(`link` がリポジトリ外を指すsymlink)が「リポジトリ内の `secret.txt`」に見えてしまう ― symlinkを辿った**後**の場所から `..` すべきなのに、辿る**前**に文字列レベルで相殺されてしまうため。

- **信頼できない/外部由来の文字列**(MCP経由のtool target path、ユーザー入力等)を扱うコードで、`..` を含み得る変数に対して `path.resolve`/`path.join`/`path.normalize` を使わない。文字列連結(テンプレートリテラル)で組み立て、symlink-aware なresolverに渡す
- 上記は**同じ関数の別分岐**でも起こり得る(実際に発生した: symlinkのターゲット文字列を組み立てる箇所で `join()` を使い、外側で確立した「`..`を畳まない」invariantを内側で破っていた)。修正のたびに、ファイル全体で `path.resolve(`/`path.join(`/`.normalize(` を grep して確認する

## `fs.realpath()` に処理を委譲する。手書きは最小限に

**事実**(glibc `stdlib/canonicalize.c` および Node.js `lib/fs.js` のソースで確認済み): OSネイティブの `realpath` は、component-by-componentで各セグメントをlstatし、symlinkなら即座に解決してから次のセグメント(`..` を含む)を適用する ― これはまさに上記invariantを満たす標準アルゴリズムであり、**Node.jsの `fs.promises.realpath()` は「パス全体が実在する」ケースで既に正しく実装済み**。手書きが必要なのは「末尾コンポーネントが未作成」を許容する拡張部分だけ。

- 新しいpath resolverを書くときは、まず `fs.realpath()` をfast pathとして呼び、`ENOENT` の場合だけ「存在する直近の祖先まで遡り、そこは `fs.realpath()` に委譲し、存在しない残りのsegmentだけ文字列で再結合する」という最小限のfallbackにする
- パス全体を独自にcomponent-by-componentで再実装しない。実装するほど、OSネイティブ関数が暗黙に処理していた挙動(Windows短縮ファイル名の正規化等)を再現し忘れるリスクが増える(実際にこのセッションでこの regression が起きた)

## OSネイティブ関数を置き換える前に、プラットフォーム差分を列挙する

`fs.realpath` のようなOSネイティブ関数を自前ロジックへ部分的にでも置き換える場合、そのネイティブ関数が暗黙に処理していた可能性のある挙動を明示的に列挙し、1つずつ判定する:

- **Windows 8.3短縮ファイル名**(`RUNNER~1` 等) ― 実際にCIで再現したバグ。`fs.realpath()` はこれを正規のロングファイル名へ変換する
- **POSIXのファイル名に含まれるリテラルな `\`** ― POSIXでは `\` は区切り文字ではなくただの1文字。パスsplitterで `/[/\\]/` のように両方を区切り文字扱いすると、POSIX上で `\` を含む正当なファイル名を誤って分割してしまう。区切り文字はプラットフォーム条件分岐にする
- **大文字小文字の区別**(Windows/macOS標準は区別しない、Linuxは区別する)
- ロケール依存の出力(このファイルの対象外 ― [[secure-subprocess-and-credentials]] 参照)

ローカル環境(macOS)で再現できないプラットフォーム挙動(Windows短縮名等)は、「ローカルで確認できない」ことをそのままリスクとして記録し、実機CI(該当OSがTier 1マトリクスに含まれる場合)の結果を待つ。ローカルで再現できないことを「問題なし」の根拠にしない。

## パターンマッチの変更は「何を新たに通すか」を確認する

区切り文字・除外セット・正規表現を変更したら、**直した誤検知(false negative)の確認だけでは不十分**。同じ変更が生む**新しい**false negativeを最低2〜3個、自分で考えて試す。

例(実際に起きた): 隣接する2つのURLをカンマで区切って誤って1つのマッチにしてしまう問題を直すため、カンマを区切り文字に追加 → 今度は「パスワード自体にカンマが含まれる」ケースで `@` の手前を切ってしまい、redactionが機能しなくなった。1つのdelimiter文字は「区切り」と「値の一部」の両方になり得ることを常に疑う。

## OWASPガイダンス

**事実**(OWASP Path Traversal公式ページ確認済み): canonicalize-then-prefix-check(このリポジトリの方式)は有効な防御だが、OWASPは「そもそもユーザー入力をファイルパスに使わない」「strict allow-listで検証する」をより強い選択肢として上位に置く。可能な場面ではそちらを優先する。

## 関連

- 資格情報・subprocess関連は [[secure-subprocess-and-credentials]]
- 一般的なエラーハンドリング規約は [[typescript-conventions]]
