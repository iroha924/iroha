# TypeScript / Zod / Node conventions (iroha)

このリポジトリ固有の実装規約。一般的なTS作法ではなく、この monorepo で実際に検証済みの書き方のみを記す。

## モジュール解決

- `packages/*` は `tsconfig.base.json` の `module`/`moduleResolution: "nodenext"` を継承する。相対importは**必ず `.js` 拡張子**を書く(`./foo.js`。ソースは `.ts` でも良い — TypeScriptが `file extension substitution` でソースへ解決する、Node16/NodeNext以来の公式仕様)。`apps/dashboard` は `moduleResolution: "bundler"` なので `.js` 拡張子は不要
- `path.resolve`/`path.join` は**内部で `..` を字句的に畳む**(symlinkを解決する前に)。信頼できない/外部由来の文字列で `..` を含み得る場合は絶対に使わない。詳細は [[path-and-symlink-safety]]
- パッケージ間の依存境界(`implementation/compatibility.md` §4「どのパッケージがどのパッケージに依存してよいか」)は `biome.json` の `overrides`(パッケージごとの `noRestrictedImports`)で**機械的に強制**されている。許可されていない `@iroha/*` importを書くと `pnpm lint` がエラーで落ち、許可されている依存先を含むメッセージが出る。§4 の表を手で照合する必要はない — `pnpm lint` を実行すれば分かる。§4 自体を変更する場合は `biome.json` の対応する override も同じコミットで更新する

## 型定義

- オブジェクト形状の型は `interface` を使う(`type` ではなく)。`biome.json` の `useConsistentTypeDefinitions` が強制する
- 例外: `z.infer<typeof xxxSchema>` で導出する契約型(後述)は `type` のまま(`interface` は型演算の結果を直接表せない)。この場合の `type` はルール違反ではなく唯一の書き方
- 名前付きexportのみを使う。default exportは使わない(`biome.json` の `noDefaultExport` が強制する)
- ファイル名は kebab-case(`biome.json` の `useFilenamingConvention` が `packages/*/src/**` に対して強制する。`apps/dashboard` は Reactコンポーネントの PascalCase 慣習があるため対象外)

## エラーハンドリング

- `@iroha/domain` の `Result<T, E>` 型(`ok`/`err`/`isOk`/`isErr`)を使う。例外を投げるのはパッケージ境界を越えない内部実装の詳細のみ(例: `safeRealpath` のsymlinkループ検知)。境界を越えるすべての公開関数は `Result` を返す
- `IrohaError` の `code` は `packages/domain/src/errors/error-code.ts` の `ERROR_CODES` から選ぶ。新しいcodeが必要な場合は `implementation/mcp-contract.md` §4 との整合を先に確認する
- エラーの `message`/`details`/`cause` に**生の絶対パス・生の引数値・資格情報を含めない**。詳細は [[secure-subprocess-and-credentials]]
- **`JSON.stringify(irohaError)` は `message`/`cause`/`stack` を含まない** — `IrohaError` は `Error` を継承しており、`message`/`cause` は `Error` コンストラクタが `enumerable: false` で設定するため、`JSON.stringify` は `code`/`retryable`/`details`(直接代入されたフィールドのみ)しか出力しない。テストの失敗時アサーションメッセージで `Result.error` の中身を確認したい場合は `` `${error.code}: ${error.message} (cause: ${String(error.cause)})` `` のように明示的に文字列化する

## Zod 4 (packages/domain, packages/config 等)

- 境界を検証する時は**必ず `.safeParse()` を使う**。`.parse()` は例外を投げるため使わない — このコードベースはリポジトリ全体で例外境界越えを許さない(上記「エラーハンドリング」の `Result<T, E>` 方針)。`safeParse()` の結果を `if (!result.success)` で分岐し、`IrohaError` にラップして `Result` として返す
- スキーマの変数名は `<名前>Schema`(`actorRefSchema`, `scopeSchema` 等)。JSON Schemaの `$defs` をミラーするスキーマには、`packages/domain/src/schemas/*.ts` の既存ファイルにならい `Mirrors schemas/<file>.schema.json \`$defs.<name>\`` という1行docstringを付ける
- **`packages/domain/src/schemas/*.ts` のスキーマは `docs/product/schemas/*.schema.json`(JSON Schema)のミラーである**。どちらか一方だけを直して他方を放置すると、実行時バリデーション(Zod)と契約ドキュメント(JSON Schema)が静かに乖離する。スキーマを追加・変更する時は両方を同じコミットで更新する。この同期を自動検証する `test:contracts` は現時点でどのpackageにも実装されていない(将来のWPでMCP contract testと共に追加予定 — `implementation-plan.md`)ため、**今は手動での同期維持が必須**
- 契約型(JSON Schemaをミラーするスキーマの型)は `type X = z.infer<typeof xSchema>` で導出する。手で別の `interface` を書いて二重管理しない — スキーマを変えれば型は自動的に追従する
- オブジェクトスキーマは `z.strictObject()` を使う(`.strict()` より意図が明確)
- 判別共用体は `z.discriminatedUnion()` を使う
- 日時は `z.iso.datetime()`。デフォルトの `offset: false` はリテラル大文字 `"Z"` 終端を要求する点に注意(オフセット付きISO文字列を許可するなら明示的に `offset: true`)
- `.refine()`/`.superRefine()` は Zod 4 で同じクラスを返す(Zod 3の `ZodEffects` ラップとは異なる)。型の穴が生まれないか `noUncheckedIndexedAccess` 込みで確認する
- パース→シリアライズのラウンドトリップを検証する場合は文字列/JSON比較ではなく `node:util` の `isDeepStrictEqual` で構造的に比較する。Zodが再構築したオブジェクトは、意味的に同一でも元のキー挿入順序を保持するとは限らない

## 構造化テキストのパース

- Markdown・YAML等の構造化フォーマットを検証する場合、正規表現の手書きパーサーで済ませない。`mdast-util-from-markdown` のような実パーサーを使う — 素朴な `#` プレフィックス正規表現は、fenced code block内の見出し風の行を誤検知するが、実際のCommonMark ASTパーサーは正しく無視する

## テスト

- `vitest` はCLIデフォルト設定のまま使う(`vitest.config.ts` は今のところ不要)。設定ファイルを追加する前に、そのpackageに本当に必要か検討する
- 外部依存(実際のsubprocess、実ファイルシステム)をモックしない。`packages/git` のテストは実際に一時gitリポジトリを作って検証する方針を踏襲する(`~/.claude/rules/testing.md` の「モックは最小限に」と一致)
- 「〜が起きることを確認した」と主張する前に、修正前のコードで**実際に赤くなる**再現テストを書く。再現できない場合(例: 別OS依存の挙動)は、その旨をテストコメント・コミットメッセージ・PRコメントに明記する

## ビルド

- `tsdown`(rolldown)がビルドを担当し、`tsc` は型チェック専用(`noEmit: true`)。tsdownはrolldown経由でtsconfigの `paths` を自動的に読むため、path alias(`apps/dashboard`)は追加設定なしで動く
- TypeScript 7.0(Corsa/ネイティブコンパイラ)はAPIが実験的。tsdownビルド時の `WARN` は既知
