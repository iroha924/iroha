---
paths:
  - "packages/*/src/**/*.test.ts"
  - "packages/*/src/test-helpers/**/*.ts"
---

# Windows CI compatibility (test code)

`windows-2025` は CI の `verify` マトリクスに含まれない(`compatibility.md` §6 で Windows は Tier 2 / best effort)。理由は下記「Windows post-close ファイルロックはアプリケーションコードから解決できない」を参照。**このファイルは削除しない** — Windows でローカル実行するテストコードや、将来 Windows CI を再検討する際の参照資料として使う。以下は macOS/Linux でしか検証していないテストコードが高確率で作り込む不具合クラス。

## パス区切り文字をハードコードしない

- `path.join`/`path.dirname`(既定 export、`path.win32`)は Windows 上で `\` を返す。テストの `expect(...).toBe("/repo/.git/iroha/index.db")` のように `/` 区切りの絶対パスを直接ハードコードすると、Windows 上でだけ落ちる
- 実装側(`path.join`/`path.dirname` を使う関数)は基本的に正しい — バグはテストの期待値の方にあることが多い。修正は実装を変えるのではなく、期待値も `join(...)` で組み立てて OS 非依存にする
- 確認方法: `packages/storage/src/rebuild.test.ts` の `createSiblingDatabasePath` テストが実例。`join("repo", ".git", "iroha")` のように相対パスの断片から組み立て、期待値も同じ `join(...)` で計算する

## Windows post-close ファイルロックはアプリケーションコードから解決できない

**事実**(SQLite公式ドキュメント https://sqlite.org/tempfiles.html、および Bun([oven-sh/bun#25964](https://github.com/oven-sh/bun/issues/25964))・better-sqlite3([JoshuaWise/better-sqlite3#376](https://github.com/JoshuaWise/better-sqlite3/issues/376))を含む複数の主要な Node SQLite バインディングで確認済み): SQLite の WAL モードでは、最後の接続が `close()` する際に排他ロックを取得 → チェックポイント実行 → `-wal`/`-shm` 削除 → ロック解放、という処理を行う。この排他ロックは Windows 上で `close()` が JS 側に返った後もしばらく(時に長時間、プロセスが終了するまで解放されない場合もある)残ることがある。`@libsql/client` local driver も例外ではない。

- 直後にファイルの `rm()`/`rename()` を行うと `EBUSY: resource busy or locked` になる。この待ち時間は不定で、**同じテストが実行のたびに 1.5 秒で足りたり、20 秒でも足りなかったりする** — リトライ予算をどれだけ大きくしても Windows CI が確実に green になる保証はない
- `packages/storage/src/connection.ts` の `closeDatabase()` は `close()` 直前に `PRAGMA journal_mode = DELETE` へ切替えて排他ロック〜チェックポイント〜削除のシーケンス自体を回避しようとするが、これも確実な解決策ではない(前提: 他に接続が残っていれば切替え自体が効かない)
- `packages/storage/src/rebuild.ts` の `renameWithRetry`、`packages/core/src/rebuild-database.ts` の `removeSiblingDatabase` は、この問題に対する**現実的な緩和策**(妥当な範囲のリトライ)であって解決策ではない。Windows で実際に動かすユーザーには有効だが、CI 上で100%再現なく通ることは保証しない
- **このクラスの `EBUSY` を、リトライ予算の拡大だけで解消しようとしない**。既に妥当な範囲(数秒〜十数秒)のリトライが実装されている箇所でなお発生する場合は、それ以上リトライ回数を増やしても収束しない可能性が高い。この制限自体が解消されたという新しい一次情報(SQLite/libSQL側の修正等)がない限り、Windows CI で100%の再現性を追求しない

`fs.rm` 自身のリトライ機構についても同様の注意が必要:

- **`fs.rm` 自身の `maxRetries`/`retryDelay` オプションを信用しない** — ドキュメント上はまさにこの用途 (`EBUSY`/`EPERM` 等の transient エラーに対する線形バックオフ再試行) のためにあるが、CI 再現で確認済みの通り、Node 24 + Windows の組み合わせでこのオプションが正しく機能せず、vitest の hook timeout (既定 10000ms) いっぱいまで戻ってこないことがある。原因は未特定 (Node 内部の `fs.rm` 実装依存)
- 対策: `fs.rm` の `maxRetries` には頼らず、**自前の短い有界リトライ**を書く(`packages/storage/src/test-helpers/tmp-db.ts` の `removeTempDir` が実例)。数回・数百 ms 単位の待機で諦め、最終的に消せなくても **エラーにせず黙って戻る** (best-effort)。各テストは `mkdtemp` で毎回一意なディレクトリを使うため、消し残りが後続テストに影響することはない
- CI で "Hook timed out in 10000ms" が特定ファイルの `afterEach` で連続して出た場合、まずこのパターン(cleanup 処理のリトライがハングしている)を疑う

## テスト自身のリトライループの worst-case とvitestのtimeoutを必ず突き合わせる

`~/.claude/rules/ci-discipline.md`「Retry budget は job timeout より十分小さく」と同じ算数を、**CIジョブ単位だけでなくテスト単位でも**行う。

- テストの `afterEach`/本体内に自前のリトライループ(`for (attempt=1; attempt<=N; attempt++) { ... await sleep(backoff) }`)を書いたら、その **worst-case 累積待機時間** (`Σ backoff`) を計算する
- vitest の既定テストタイムアウトは **5000ms**。この monorepo は `vitest.config.ts` を置かない方針([[typescript-conventions]])なので、明示的に `it(name, fn, timeoutMs)` の第3引数で上書きしない限りこの既定値が効く
- リトライの worst-case が既定タイムアウトに近い/超えると、意図したリトライ処理自体が `Error: Test timed out in 5000ms` という**別の失敗**に化ける。これは一見「ハングした」ように見えるが実際はリトライが動作している証拠であり、コードのバグではなく **リトライ予算とタイムアウトの不整合**が原因
- 対策: テスト自身がリトライを含む処理を呼ぶ場合、そのテストの `it(...)` に明示的なタイムアウト値を渡す。目安は `Σ backoff` の 1.5〜2倍程度の余裕を持たせる(セットアップ処理自体にも数百ms〜数秒かかるため)
- リトライ予算を大きくするたびに、この突き合わせをやり直す。「リトライ回数を増やしたらテストが timeout で落ちた」は、リトライが効いていないのではなく **このタイムアウトを更新し忘れている**サインであることが多い

## CI 失敗が別パッケージ・原因不明のとき

- Windows job で自分が触っていないパッケージのテストが落ちる、あるいはエラーメッセージなしに `typecheck`/`build` が exit 1 する場合がある。これは大抵 CI インフラ側の flake であり、コードの問題ではない
- 対応は推測でコードを変更せず、CI 実行履歴で同じテストが直近の実行で通っていたかを確認してから判断する。詳細は `~/.claude/rules/ci-discipline.md`「CI 失敗は『新規か既存か』を履歴で確認してから対応する」

## 関連

- 一般的な CI 検証規律は `~/.claude/rules/ci-discipline.md`
- パス解決・symlink の安全性は [[path-and-symlink-safety]](本ファイルとは別の関心事 — あちらはセキュリティ境界、こちらはクロスプラットフォーム互換性)
- 経緯の全記録は `implementation/decision-log.md` ID-026(12)-(14)
