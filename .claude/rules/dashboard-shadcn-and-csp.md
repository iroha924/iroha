---
paths:
  - "apps/dashboard/**"
  - "apps/e2e/**"
  - "packages/api/src/security.ts"
  - "packages/api/src/static.ts"
---

# Dashboard UI: shadcn/ui + Base UI under a strict CSP

Knowledge from adopting shadcn/ui into `apps/dashboard`. Apply it when adding/replacing dashboard components, touching the CSP, or adding any UI/animation library. The single hard constraint is the strict `style-src 'self'` CSP — get it wrong and the app renders with broken styles that unit tests and a dev spike do **not** catch (only the e2e does).

## The stack that is actually installed

- **shadcn/ui on Base UI** (`@base-ui/react`) — Base UI is shadcn's 2026 default primitive, **not Radix**. Components live in `apps/dashboard/src/components/ui/` (vendored, repo-owned). Brand composites (Mark, PageHeader, Loading, EmptyState, ErrorState, FilterChip, LoadMore, BackLink) live in `components/brand.tsx`; the shared status→Badge-tone mappers in `lib/status.ts`.
- Add a component: `pnpm dlx shadcn@latest add <name>` (base = Base UI, preset `nova`), then `pnpm --filter @iroha/dashboard exec biome check --write src` to bring it to repo style.
- **Do not overwrite the components you have already customized** (`button`, `chart`, `calendar`, `scroll-area`, …). `shadcn add` prompts to overwrite existing files and `-y` does **not** skip that prompt — run it as `yes n | pnpm dlx shadcn@latest add <name> -y` so every overwrite prompt answers "no" while new files still install.
- Base UI components compose via a `render` prop (`<PopoverTrigger render={<Button/>} />`), not Radix's `asChild`.

## The hard constraint: `style-src 'self'` (no `unsafe-inline`)

`packages/api/src/security.ts` sets `Content-Security-Policy: … style-src 'self' 'nonce-<per-process>' …`. Two mechanisms are treated very differently:

- **CSSOM runtime positioning is NOT blocked.** Floating UI (Popover / Select / Dropdown / Tooltip / Menu positioning) writes `element.style.transform` at runtime — CSP `style-src` governs markup `<style>`/`style=""`, not CSSOM mutation. React's `style={{…}}` prop is also CSSOM. So all the floating overlays work under the strict CSP with no nonce.
- **Injected `<style>` ELEMENTS are blocked** (`style-src-elem`). Anything that does `document.head.appendChild(styleEl)` at runtime is refused unless it carries the matching nonce.

How the dashboard stays clean:

- **Base UI**: the app is wrapped in `<CSPProvider nonce={cspNonce()} disableStyleElements>` (`main.tsx`). `disableStyleElements` makes Base UI **never inject a `<style>`** — shadcn already styles every component with Tailwind classes, so Base UI's injected styles are redundant. This is the robust fix: it removes the CSP surface instead of depending on the nonce round-trip.
- **The per-process nonce** (for the one remaining injector, shadcn's Chart `ChartStyle`): generated in `security.ts` and cached on `globalThis` (`__irohaCspNonce__`) so a bundler that emits two copies of the module can't mint two nonces — **the CSP header and the injected `<meta name="csp-nonce">` MUST carry the identical value or every nonced style is refused**. `static.ts` injects the meta into the served HTML (`</head>` replace); `lib/csp.ts` `cspNonce()` reads it.
- **Charts**: color bars via `<Cell fill="var(--chart-N)">` and keep the `ChartConfig` color-less — then `ChartStyle` returns null and injects nothing (Overview does this). If a chart uses config colors, `ChartStyle` injects a nonced `<style>` and relies on the meta/nonce round-trip.

## Banned: sonner — and any library that injects an un-nonced `<style>`

- **sonner (toasts) is fundamentally incompatible with this CSP.** It injects its CSS via `head.appendChild(<style>)` with **no nonce support** (verified in its dist), so every toast style is refused under `style-src 'self' 'nonce-…'`. **Do not reintroduce `sonner` or `<Toaster>`.** Toasts are inline notices instead (a Tailwind-class banner off a `notice` state — see `Settings.tsx` / `ReviewDetail.tsx`). If toasts are wanted, the only path is a custom Tailwind-only toast that injects no `<style>`.
- **Before adopting ANY new UI / animation / chart library, check whether it injects a `<style>` at runtime**: `grep -riE "appendChild\(.*style|insertRule|<style" node_modules/<lib>/dist`. If it does and exposes no `nonce` prop, it will not work under this CSP — pick a Tailwind-class-based alternative or drop it.

## Verify the CSP with the e2e test — a dev spike is not enough

- A dev-time meta-CSP spike **missed sonner** because the spike page did not mount the always-present `<Toaster>`. The **e2e test caught it**: `apps/e2e/tests/approve-candidate.spec.ts` collects `page.on("console")` CSP-violation errors across the whole journey and asserts zero at the end.
- So any change that could inject a `<style>` (a config-colored chart, a Dialog/Sheet/ScrollArea, a new library) MUST be verified with `pnpm --filter @iroha/e2e test:e2e` against the **real packaged server** (`iroha dashboard`). The source-based unit test (`static.test.ts`, which only asserts header-nonce == meta-nonce) and the dev spike are necessary but **not sufficient** — bundling and always-mounted components behave differently there.

## Theming, tokens, and lint

- Brand palette is mapped onto shadcn's semantic tokens (OKLCH) in `apps/dashboard/src/index.css`. Both vocabularies coexist and render identically: brand utilities (`bg-paper` / `text-ink` / `bg-matcha`) and shadcn semantic (`bg-background` / `bg-primary` / `text-muted-foreground`). Badge carries brand status tones (`approve`/`pending`/`reject`/`neutral`) added to its cva.
- **No dark mode**: `@custom-variant dark (&:is(.dark *))` binds `dark:` to an explicit `.dark` class (never the OS `prefers-color-scheme`), so the `dark:` utilities shadcn ships stay inert. The identity is light-only "kinari paper"; a real dark theme is a deliberate future task, not a media-query fallback.
- **No hardcoded hex in components** — reference tokens. A React Flow `<Background color=…>` etc. uses `var(--color-hairline)`, not `#E6DCC8`.
- **Catalog discipline**: `shadcn add` writes deps with caret ranges (`^x.y.z`) and adds the `shadcn` CLI to `dependencies`. Pin every added dep to an **exact** version in `pnpm-workspace.yaml`'s catalog (repo rule), grouped under the dashboard shadcn comment cluster; move the `shadcn` CLI to `devDependencies`; and drop deps you don't use (the preset's Geist font, sonner's `next-themes`).
- **a11y on vendored primitives**: `components/ui/**` primitives trip context-free a11y rules (`noLabelWithoutControl`, `useSemanticElements`, `useFocusableInteractive`, `useKeyWithClickEvents`) whose concern is satisfied at the usage site. Suppress with an **inline `// biome-ignore lint/a11y/<rule>: <reason>`** at the call site — **not** a `biome.json` override (and note `biome.json` does not accept comments; a stray `//` there makes Biome fall back to defaults). App pages under `src/pages/**` keep full a11y linting.

## Related

- Visual identity (palette, "avoid the written-by-AI look", editorial eyebrow reserved for genuinely distinct kickers, active nav carries the three-circle mark): [[brand-and-design]]
- English-only for everything under `.claude/**` and shipped artifacts: [[distributable-language]]
- TS / module-resolution / Zod conventions: [[typescript-conventions]]
- See CI/e2e through to completion after a push: `~/.claude/rules/ci-discipline.md`
