# TypeScript / Zod / Node conventions (iroha)

このリポジトリ固有の実装規約。一般的なTS作法ではなく、この monorepo で実際に検証済みの書き方のみを記す。

## モジュール解決

- `packages/*` は `tsconfig.base.json` の `module`/`moduleResolution: "nodenext"` を継承する。相対importは**必ず `.js` 拡張子**を書く(`./foo.js`。ソースは `.ts` でも良い — TypeScriptが `file extension substitution` でソースへ解決する、Node16/NodeNext以来の公式仕様)。`apps/dashboard` は `moduleResolution: "bundler"` なので `.js` 拡張子は不要
- `path.resolve`/`path.join` は**内部で `..` を字句的に畳む**(symlinkを解決する前に)。信頼できない/外部由来の文字列で `..` を含み得る場合は絶対に使わない。詳細は [[path-and-symlink-safety]]

## エラーハンドリング

- `@iroha/domain` の `Result<T, E>` 型(`ok`/`err`/`isOk`/`isErr`)を使う。例外を投げるのはパッケージ境界を越えない内部実装の詳細のみ(例: `safeRealpath` のsymlinkループ検知)。境界を越えるすべての公開関数は `Result` を返す
- `IrohaError` の `code` は `packages/domain/src/errors/error-code.ts` の `ERROR_CODES` から選ぶ。新しいcodeが必要な場合は `implementation/mcp-contract.md` §4 との整合を先に確認する
- エラーの `message`/`details`/`cause` に**生の絶対パス・生の引数値・資格情報を含めない**。詳細は [[secure-subprocess-and-credentials]]

## Zod 4 (packages/domain, packages/config 等)

- オブジェクトスキーマは `z.strictObject()` を使う(`.strict()` より意図が明確)
- 判別共用体は `z.discriminatedUnion()` を使う
- 日時は `z.iso.datetime()`。デフォルトの `offset: false` はリテラル大文字 `"Z"` 終端を要求する点に注意(オフセット付きISO文字列を許可するなら明示的に `offset: true`)
- `.refine()`/`.superRefine()` は Zod 4 で同じクラスを返す(Zod 3の `ZodEffects` ラップとは異なる)。型の穴が生まれないか `noUncheckedIndexedAccess` 込みで確認する

## テスト

- `vitest` はCLIデフォルト設定のまま使う(`vitest.config.ts` は今のところ不要)。設定ファイルを追加する前に、そのpackageに本当に必要か検討する
- 外部依存(実際のsubprocess、実ファイルシステム)をモックしない。`packages/git` のテストは実際に一時gitリポジトリを作って検証する方針を踏襲する(`~/.claude/rules/testing.md` の「モックは最小限に」と一致)
- 「〜が起きることを確認した」と主張する前に、修正前のコードで**実際に赤くなる**再現テストを書く。再現できない場合(例: 別OS依存の挙動)は、その旨をテストコメント・コミットメッセージ・PRコメントに明記する

## ビルド

- `tsdown`(rolldown)がビルドを担当し、`tsc` は型チェック専用(`noEmit: true`)。tsdownはrolldown経由でtsconfigの `paths` を自動的に読むため、path alias(`apps/dashboard`)は追加設定なしで動く
- TypeScript 7.0(Corsa/ネイティブコンパイラ)はAPIが実験的。tsdownビルド時の `WARN` は既知
