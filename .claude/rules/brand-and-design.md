# iroha brand & design

iroha's visual identity is **organic color** (an unbleached-cream ("kinari") base + a three-color ring). The UI avoids the "written by an AI" feel and stays warm, editorial, and restrained. **Depth comes from tone (the three layers of paper), not from shadow.**

## Palette (derived from the logo, fixed values)

| Role | HEX | Use |
|---|---|---|
| paper | `#F4EFE5` | Page base (a single unbleached-cream ("kinari") tone) |
| paper-raised | `#FBF7EE` | Card/surface (the brightest paper = reads as raised) |
| paper-inset | `#F0E8D8` | Sunken area (code well, hover background) |
| hairline | `#E6DCC8` | Default warm hairline border |
| hairline-strong | `#D8CDB4` | Dividers, field border on focus |
| ink | `#2E2A22` | Body text (**do not use pure black `#000`** = a sumi-ink ("sumi") tone) |
| ink-muted | `#6F675A` | Secondary, meta |
| ink-faint | `#968D7C` | placeholder, tertiary information |
| matcha | `#6E7B57` | **Primary action / approve** (hover `#5D6949`) |
| approve / tint | `#5F7048` / `#E9EBDE` | Approve-family text / pale background |
| persimmon | `#C26A3C` | **Reject / danger** (hover `#A9572D`, tint `#F3E1D6`) |
| warn / tint | `#A8823F` / `#F0E7D6` | Warning, pending |
| clay | `#BC9870` | **Decoration only** (never a text color on paper) |

- **Restraint**: the only brand color that carries weight is matcha (primary + approve). persimmon is reject-only. clay is decoration. Leave room to add a muted violet/purple as a fourth badge color to the family in the future.
- Already defined as Tailwind v4 `@theme` tokens in `apps/dashboard/src/index.css` (`bg-paper` `text-ink` `bg-matcha`, etc.).

## Typography (CSP forbids remote fonts = system stack only)

- `--font-sans`: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, ...`
- `--font-display`: `ui-rounded, "SF Pro Rounded", system-ui, ...` (echoes the rounded wordmark; used for headings)
- `--font-mono`: `ui-monospace, "SF Mono", Menlo, ...`
- Give headings refinement with the display face + negative tracking + weight 600 (**do not raise to 700/800**). Numbers (stat/count/timestamp/numeric table columns) use `tabular-nums`.

## Shape & spacing

- Keep corner rounding soft and squircle-like: card `rounded-2xl`, input/button `rounded-xl`, pill `rounded-full`.
- Borders are 1px warm hairlines. **No shadows as a rule** (at most a single `0 1px 2px rgba(46,42,34,0.05)` step, never stacked).
- Keep spacing generous. max content width `1120px`, card padding `p-6`, row height `py-3.5`.

## Avoiding the "written by an AI" feel (do/don't)

- Blue/indigo primary → **matcha**. White cards on cold gray-50 → **the three warm-paper layers**.
- Strong/multi-step box-shadow → **hairline + tone**. Purple→pink or neon gradients → **flat earth tones** (tint 2-3%).
- Cold slate/zinc text and borders → **a warm brown-gray raised from sumi ("sumi") ink**.
- Emoji icons → **thin-line icons (Lucide family)**. A grid of uniform metric boxes → **one hero + hierarchy and generous whitespace**.
- Do not put a border on every element (prefer whitespace and tone). Do not default everything to an 8px corner radius (use larger rounding + generous padding).

## Signature (on-brand details)

1. **The rounded heading face** (`ui-rounded`) echoes the hand-drawn wordmark.
2. **The three-circle motif** (matcha/clay/persimmon) recurs in the loader, empty state, and active nav (`Mark` in `components/ui.tsx`).
3. **Depth from tone, not shadow** (the three layers paper / raised / inset).
4. **matcha focus / selection** (unify `::selection` and the focus ring to matcha).
5. **A sumi-ink top rule + an optional editorial eyebrow** (a 2px ink rule above the page title; an uppercase tracked-out label). The ink rule is the constant; the eyebrow is used **only when it adds a distinct kicker** — never a repeat of the page title (an "Sessions" eyebrow over a "Sessions" title reads as an AI tic, not editorial).

## Related

- For language (English by default), see [[distributable-language]].
- Brand assets live in `apps/dashboard/public/` (the full favicon set, lockup/mark/wordmark SVGs). The masters are stored separately.
