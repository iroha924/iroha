---
paths:
  - "packages/*/src/**/*.test.ts"
  - "packages/*/src/test-helpers/**/*.ts"
---

# Windows CI compatibility (test code)

CI matrix は `windows-2025` を含む(Tier 1)。macOS/Linux でしか検証していないテストコードは、以下の 2 クラスの不具合を高確率で作り込む。WP-03(`packages/storage`)で実際に CI 上で踏んだ内容。

## パス区切り文字をハードコードしない

- `path.join`/`path.dirname`(既定 export、`path.win32`)は Windows 上で `\` を返す。テストの `expect(...).toBe("/repo/.git/iroha/index.db")` のように `/` 区切りの絶対パスを直接ハードコードすると、Windows 上でだけ落ちる
- 実装側(`path.join`/`path.dirname` を使う関数)は基本的に正しい — バグはテストの期待値の方にあることが多い。修正は実装を変えるのではなく、期待値も `join(...)` で組み立てて OS 非依存にする
- 確認方法: `packages/storage/src/rebuild.test.ts` の `createSiblingDatabasePath` テストが実例。`join("repo", ".git", "iroha")` のように相対パスの断片から組み立て、期待値も同じ `join(...)` で計算する

## Windows 上でのファイルロック待ちは秒単位になりうる

- **事実**(CI 再現で確認済み): ネイティブ binding (`@libsql/client` local driver 等) が保持するファイルハンドルは、JS 側の `close()` 呼び出しが返った後もしばらく Windows 上で開いたままになりうる。直後に一時ディレクトリを `rm(dir, { recursive: true })` すると `EBUSY: resource busy or locked` になる
- **`fs.rm` 自身の `maxRetries`/`retryDelay` オプションを信用しない** — ドキュメント上はまさにこの用途 (`EBUSY`/`EPERM` 等の transient エラーに対する線形バックオフ再試行) のためにあるが、CI 再現で確認済みの通り、Node 24 + Windows の組み合わせでこのオプションが正しく機能せず、vitest の hook timeout (既定 10000ms) いっぱいまで戻ってこないことがある。原因は未特定 (Node 内部の `fs.rm` 実装依存)
- 対策: `fs.rm` の `maxRetries` には頼らず、**自前の短い有界リトライ**を書く(`packages/storage/src/test-helpers/tmp-db.ts` の `removeTempDir` が実例)。数回・数百 ms 単位の待機で諦め、最終的に消せなくても **エラーにせず黙って戻る** (best-effort)。各テストは `mkdtemp` で毎回一意なディレクトリを使うため、消し残りが後続テストに影響することはない
- CI で "Hook timed out in 10000ms" が特定ファイルの `afterEach` で連続して出た場合、まずこのパターン(cleanup 処理のリトライがハングしている)を疑う

## CI 失敗が別パッケージ・原因不明のとき

- Windows job で自分が触っていないパッケージのテストが落ちる、あるいはエラーメッセージなしに `typecheck`/`build` が exit 1 する場合がある。これは大抵 CI インフラ側の flake であり、コードの問題ではない
- 対応は推測でコードを変更せず、CI 実行履歴で同じテストが直近の実行で通っていたかを確認してから判断する。詳細は `~/.claude/rules/ci-discipline.md`「CI 失敗は『新規か既存か』を履歴で確認してから対応する」

## 関連

- 一般的な CI 検証規律は `~/.claude/rules/ci-discipline.md`
- パス解決・symlink の安全性は [[path-and-symlink-safety]](本ファイルとは別の関心事 — あちらはセキュリティ境界、こちらはクロスプラットフォーム互換性)
