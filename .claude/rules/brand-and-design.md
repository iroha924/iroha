# iroha ブランド & デザイン

iroha の視覚的アイデンティティは**オーガニックカラー**（生成り地 + 三色の環）。UI は「AI が書いた感」を避け、温かく・エディトリアルで・抑制の効いたデザインにする。**深みは影ではなくトーン（紙の三層）で出す。**

## パレット（ロゴ由来・確定値）

| 役割 | HEX | 用途 |
|---|---|---|
| paper | `#F4EFE5` | ページ地（生成り単色） |
| paper-raised | `#FBF7EE` | カード/サーフェス（最も明るい紙 = 浮いて見える） |
| paper-inset | `#F0E8D8` | 沈んだ領域（コード well、hover 背景） |
| hairline | `#E6DCC8` | 既定の暖色ヘアライン境界 |
| hairline-strong | `#D8CDB4` | 区切り・focus 時のフィールド境界 |
| ink | `#2E2A22` | 本文（**純黒 `#000` は使わない**＝墨色） |
| ink-muted | `#6F675A` | 副次・メタ |
| ink-faint | `#968D7C` | placeholder・三次情報 |
| matcha | `#6E7B57` | **プライマリ操作 / 承認**（hover `#5D6949`） |
| approve / tint | `#5F7048` / `#E9EBDE` | 承認系テキスト / 淡背景 |
| persimmon | `#C26A3C` | **却下 / danger**（hover `#A9572D`, tint `#F3E1D6`） |
| warn / tint | `#A8823F` / `#F0E7D6` | 警告・pending |
| clay | `#BC9870` | **装飾のみ**（紙上のテキスト色には使わない） |

- **抑制**: 重みを持つブランド色は matcha だけ（primary + approve）。persimmon は却下のみ。clay は装飾。将来 muted violet/紫 を 4 つ目の badge 色として family に加える余地を残す。
- Tailwind v4 の `@theme` トークンとして `apps/dashboard/src/index.css` に定義済み（`bg-paper` `text-ink` `bg-matcha` 等）。

## タイポグラフィ（CSP 上リモートフォント不可 = system stack のみ）

- `--font-sans`: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, ...`
- `--font-display`: `ui-rounded, "SF Pro Rounded", system-ui, ...`（丸い wordmark に呼応。見出しに使う）
- `--font-mono`: `ui-monospace, "SF Mono", Menlo, ...`
- 見出しは display 面 + 負の tracking + weight 600 で品を出す（**700/800 に上げない**）。数値（stat/カウント/タイムスタンプ/表の数値列）は `tabular-nums`。

## 形・余白

- 角丸は squircle 的に柔らかく: カード `rounded-2xl`、input/button `rounded-xl`、pill `rounded-full`。
- 境界は 1px 暖色ヘアライン。**影は原則なし**（最大でも `0 1px 2px rgba(46,42,34,0.05)` 一段のみ、重ねない）。
- 余白は広く。max content width `1120px`、カード padding `p-6`、行高 `py-3.5`。

## 「AI が書いた感」を避ける（do/don't）

- 青/indigo プライマリ → **matcha**。白カード on 冷たい gray-50 → **暖色紙の三層**。
- 強い/多段の box-shadow → **ヘアライン + トーン**。紫→ピンクや neon グラデ → **フラットな土色**（tint 2〜3%）。
- 冷たい slate/zinc の文字・境界 → **墨から起こした暖色ブラウングレー**。
- 絵文字アイコン → **細線アイコン（Lucide 系）**。均一な metric ボックスの grid → **hero 1 つ + 階層と広い余白**。
- 全要素に border を付けない（余白とトーンを優先）。8px 角丸一辺倒にしない（大きめ角丸 + 広い padding）。

## シグネチャー（on-brand な細部）

1. **丸い見出し面**（`ui-rounded`）が手書き wordmark に呼応。
2. **三円モチーフ**（matcha/clay/persimmon）を loader・empty state・active nav に反復（`components/ui.tsx` の `Mark`）。
3. **影でなくトーンで深み**（paper / raised / inset の三層）。
4. **matcha の focus / selection**（`::selection` と focus ring を matcha に統一）。
5. **エディトリアルな eyebrow + 墨のトップルール**（ページタイトル上の 2px ink rule、uppercase tracked-out ラベル）。

## 関連

- 言語（英語既定）は [[distributable-language]]。
- ブランド資産は `apps/dashboard/public/`（favicon 一式・lockup/mark/wordmark SVG）。原本は別途保管。
