# iroha — Dashboard and Local API Contract v1

> Status: Implementation Baseline v1  
> Updated: 2026-07-18

## 1. Purpose

The dashboard is the human control plane for local session visibility, candidate review, approval, search, graph exploration, diagnostics, and shared-config editing. It is not a hosted multi-user application.

## 2. Frontend stack

| Library | Baseline |
|---|---:|
| React | 19.2.7 |
| Vite | 8.1.5 |
| `@vitejs/plugin-react` | 6.0.3 |
| React Router | 8.2.0 |
| TanStack Query | 5.101.2 |
| Tailwind CSS | 4.3.3 |
| React Flow (`@xyflow/react`) | 12.11.2 |
| Recharts | 3.9.2 |

State rules:

- server state: TanStack Query;
- URL state: filters, search query, selected graph root, pagination cursor;
- component state: local UI only;
- no global state library in v0.1;
- no server-side rendering;
- no analytics SDK or remote font dependency.

## 3. Server startup and authentication

`iroha dashboard`:

1. resolves and validates the repository;
2. opens DB read/write and checks schema;
3. generates a 256-bit random launch token;
4. binds Hono to `127.0.0.1` and an available random port;
5. serves built static assets and JSON API from one origin;
6. opens `http://127.0.0.1:<port>/#token=<base64url>` unless `--no-open`;
7. exits on SIGINT/SIGTERM after closing DB.

The SPA reads the fragment, POSTs it once to `/api/auth/exchange`, receives an HttpOnly session cookie, and removes the fragment with `history.replaceState`.

Cookie:

- random opaque value;
- HttpOnly;
- SameSite=Strict;
- Path=/;
- no Secure flag on plain loopback HTTP;
- valid only for the current process lifetime;
- rotated on each dashboard start.

Every state-changing request requires:

- valid cookie;
- exact `Origin` matching the local server origin;
- JSON content type;
- `X-Iroha-Request: 1` header.

The server never binds `0.0.0.0` unless a future explicit authenticated remote mode is designed by ADR.

## 4. API conventions

Base path: `/api/v1`.

Success:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "req_..."
  }
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "The candidate changed. Reload before approving.",
    "retryable": false,
    "fieldErrors": {}
  },
  "meta": {
    "requestId": "req_..."
  }
}
```

Rules:

- JSON only except static assets and export downloads;
- unknown request fields rejected;
- RFC 3339 UTC timestamps;
- IDs remain strings;
- cursor pagination, default 30, maximum 100. `GET /api/v1/candidates` additionally accepts `offset`, because the Review queue renders numbered pages and a keyset cursor cannot be computed for a page the client has never fetched — numbering over cursors alone would mean requesting every intervening page. `cursor` wins if both are sent;
- deterministic sort with ID tie-breaker;
- errors do not contain SQL, stack traces, absolute paths, or secret values;
- all user-visible errors have stable codes.

The API is built with `@hono/zod-openapi`: each route validates its request body/params against a Zod schema, and the generated **OpenAPI 3.1** document is served at `GET /api/doc`. That endpoint is unauthenticated by design — it describes the API's shape (paths, request schemas, the required `X-Iroha-Request` header on mutations) with no repository data or secrets, on the loopback-only server — the same openness as `POST /api/auth/exchange`. Query parameters accept a single or repeated value and are parsed leniently in the handler (an invalid value is ignored, never a 400), so the strict body validation and the lenient query behavior above both hold.

## 5. Endpoint contract

### Authentication and health

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/exchange` | exchange launch token for cookie |
| `POST` | `/api/auth/logout` | invalidate local session |
| `GET` | `/api/v1/health` | process and DB liveness |
| `GET` | `/api/v1/bootstrap` | repository, user, feature, schema summary |

### Overview

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/digest` | one period's Digest: aggregate facts, prior-period comparison, and composed prose |
| `GET` | `/api/v1/overview` | counts, recent Sessions, pending Candidates, unresolved items |
| `GET` | `/api/v1/sessions` | paginated Sessions (the graph's seed picker; no page lists them) |

`GET /api/v1/digest` query parameters: `unit` (`week`|`month`, default this developer's stored
`digest.period`) and `offset` (integer 0–520; 0 is the current period, higher values are back
issues). Neither is rejected: an unknown `unit` is ignored and falls back to the stored preference,
while an out-of-range `offset` is **clamped** to `0..520` rather than ignored — ignoring it would
answer a request for 520+ periods ago with the *current* period. The response carries the resolved
`period.offset`, which is what a client must read to know which issue it was served. Period
boundaries are UTC calendar boundaries, so the same key names the same window for every teammate.
Read-only; prose is written through MCP (`save_digest_prose`), not through this API.

Session filters: platform, actor, status, label, Issue/PR ref, date range, unresolved-only.

`GET /api/v1/sessions` query parameters: `cursor`, `limit`, `platform` (`claude_code`|`codex`), `summaryStatus` (`none`|`draft`|`approved`), `from`, `to` (RFC 3339 datetime; the inclusive date range is compared against `last_seen_at` — the column the list is ordered and cursored by and the date each row shows). Unknown, out-of-enum, or non-RFC-3339 filter values are ignored.

Raw prompt, transcript, assistant message, and full tool payload endpoints do not exist.

### Candidate review

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/candidates` | review queue |
| `GET` | `/api/v1/candidates/:id` | payload, source, duplicate/conflict hints |
| `PATCH` | `/api/v1/candidates/:id` | validate and edit draft |
| `POST` | `/api/v1/candidates/:id/approve` | human approval + canonical publish |
| `POST` | `/api/v1/candidates/:id/reject` | reject with optional reason |
| `POST` | `/api/v1/candidates/:id/supersede` | replace pending/approved candidate relation |
| `GET` | `/api/v1/people` | names an approval can be credited to |

`GET /api/v1/candidates` query parameters: `cursor`, `offset`, `limit`, `status` (`pending`|`approved`|`rejected`|`superseded`, default `pending`).

The candidate list also returns `total`: how many candidates exist at the requested `status`. The page and `total` are read inside one transaction, so they always describe the same snapshot — otherwise a concurrent write could make the count disagree with the rows and the queue would render a page that is not there.

That snapshot holds **within** a request, not across them, and `offset` addresses a position rather than a row. So when the queue changes between two page requests — which it does routinely, since approving removes the row being paged and the list polls — the window shifts, and a single forward pass through the pages can skip a candidate or show one twice. It is not lost: the row moves to an adjacent page and is there on revisiting or reloading. This is accepted deliberately for the Review queue, which is a work queue drained by deciding candidates rather than a list read exhaustively in one pass. A caller that must enumerate every candidate exactly once should page by `cursor`, which names a row and is immune to this.

`GET /api/v1/people` returns `{ "names": [...], "self": "..." | null }`, the names an approval may be credited to.

- `names` are the people the picker offers: distinct commit author names from the last 2000 commits reachable from **any** ref (not only HEAD — someone who has committed on a feature branch can still review), plus `self` when it is set, so a newcomer who has not committed yet is still selectable. It is a list of candidates to credit, not a census of authors. In UTF-16 code-unit order — deterministic rather than linguistic, so it does not depend on the server's ICU build. Ordering is never by contribution and no activity count is returned: this identifies people, it does not rank them.
- A name is omitted when it ends in `[bot]` (GitHub's naming for App accounts), exceeds the 120-character limit the approve endpoint enforces on `displayName`, or contains a character that would make it misread — C0/C1 controls, the bidirectional overrides and isolates, and the zero-width space. ZWNJ and ZWJ are kept, because they spell real names in Persian and Indic scripts. This is hygiene on a suggestion list, not a boundary: the approve endpoint applies no such filter, and homoglyphs are out of reach of any character class. The bot rule is deliberately this narrow: an open-ended list of bot spellings never converges, and the field accepts a typed name anyway.
- `self` is the local `git config user.name` when it passes those same rules, for prefilling the reviewer field; otherwise `null`. It is read in a sanitized environment: `@iroha/git` clears `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `XDG_CONFIG_HOME` before invoking Git, so that an ambient value cannot redirect Git at a config file the environment chose. Git falls back to `$HOME`, so the usual `~/.gitconfig` and `~/.config/git/config` are still read — but an identity that lives **only** in a non-default `$XDG_CONFIG_HOME` is not visible here and `self` is `null`. That is the deliberate cost of not letting the environment pick the config file; the reviewer field is free text, so the name can still be typed.
- The source is Git rather than the `actors` table, which only the Forge sync writes and which carries no repository scope.
- An empty `names` and a `null` `self` are both valid, and the reviewer field still accepts a name that is not on the list.

Candidate reads return `revisionToken`. PATCH/approve/reject/supersede require the same token. A mismatch returns HTTP 409 `CONFLICT` with no automatic merge.

Approve request:

```json
{
  "revisionToken": "...",
  "actor": {
    "provider": "git",
    "displayName": "Example Reviewer"
  },
  "comment": "Verified against PR #123"
}
```

Approval invokes the exact transaction in `contracts/canonical.md`. The API does not accept a target canonical path from the browser; the server derives it from validated type and ID.

### Knowledge and graph

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/knowledge` | approved/local knowledge list |
| `GET` | `/api/v1/knowledge/:id` | body, provenance, relations, revision |
| `GET` | `/api/v1/entities/:id/relations` | bounded neighbors/subgraph |
| `POST` | `/api/v1/graph/query` | graph roots, types, direction, depth |
| `GET` | `/api/v1/graph/path` | bounded path between two IDs |

`GET /api/v1/knowledge` query parameters: `cursor`, `limit`, `offset`, `status` (repeatable; `approved`|`superseded`|`archived`, default `approved`), `type` (repeatable; one of the seven knowledge `entity_type`s). Values outside these sets are ignored, and `type` never widens beyond the knowledge set. The response carries `total` alongside `items` and `nextCursor`, so the page can number itself.

`offset` addresses a row position and is ignored when `cursor` is given. The dropped-row hazard recorded for the review queue does not apply here: that queue shrinks under the reader because deciding a candidate removes it, whereas this list only grows — approving adds a row and superseding changes a status. The page and `total` are still read in one transaction, so a concurrent `sync` cannot make the count disagree with the rows it is counting.

Graph query limits: depth 4, 200 edges, 200 nodes. UI must show truncation.

### Search

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/search` | hybrid/lexical/vector/graph search |

Search request mirrors MCP `search` without session token. Pending Candidate search requires `scope=review` and is limited to the Review Queue UI.

### Sync, settings, and diagnostics

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/sync` | canonical/Git sync; Forge optional |
| `GET` | `/api/v1/sync/status` | cursors, dirty markers, last result |
| `GET` | `/api/v1/settings` | shared config plus redacted local status |
| `PATCH` | `/api/v1/settings/shared` | update `.iroha/config.yaml` safely |
| `PATCH` | `/api/v1/settings/local` | update Git-internal local settings (a known key is schema-validated: `retention.local_events` must be `{"days": 1-3650 or null}` — see `database.md` §15) |
| `GET` | `/api/v1/doctor` | capability diagnostics |
| `POST` | `/api/v1/doctor/repair` | explicitly selected safe repair |
| `GET` | `/api/v1/events` | recent local diagnostics events (`event_log`) |

`GET /api/v1/events` returns the `event_log` rows newest first, under the §4 page-size rule (`?limit=`, default 30, maximum 100): event kind, source, duration, outcome, and stable error code only — the columns §10 of `contracts/hooks.md` permits. `event_log.adapter` carries the source identifier of whichever producer wrote the row: the tool name for MCP, the provider for a Forge sync, and the matched route pattern (`POST /api/v1/candidates/:id/approve` — the router's own parameter form, not OpenAPI's `{id}`) for an API request. The concrete URL, its query string, and its path parameter values are never recorded.

Only **failed** requests under `/api/v1/*` are recorded, and only after authentication — the middleware sits inside `requireCookie`, and `POST /api/auth/exchange` is outside it entirely, so nothing unauthenticated can write to an unpruned table. A successful request writes no row: the SPA polls several pages every 5 s (§7), which would fill the list within minutes, and an approval is already durable as canonical data. **Hooks write no row at all**: the INSERT waits on libSQL's `busy_timeout` whenever another process holds the write lock, which exceeds every hook budget in `hooks.md` §7, so the row would cost the very outputs worth diagnosing (a Guardrail deny, a Stop continuation).

`event_log` is disposable local index state: `sync --rebuild` builds a fresh database and therefore starts its history over, like every other non-canonical table except the deliberately-carried embeddings.

Repair operations are allowlisted. The browser cannot run arbitrary shell commands.

## 6. Initial routes and information architecture

```text
/
/overview
/review
/review/:candidateId
/knowledge
/knowledge/:knowledgeId
/search
/graph
/settings
/doctor
```

### Digest (`/`)

The front page is the period Digest (architecture.md ADR-016). Show:

- the composed headline and deck for the period, or templated copy when none has been composed —
  the page is never blank, because the numbers are computed on request;
- Guardrail denials for the period, attributed to the Rule that produced each one, with the
  previous period's total beside it;
- where denials clustered, when iroha found a cluster;
- Sessions, Checkpoints by outcome, and pending recurring review lessons;
- knowledge approved in the period, Guardrails added or changed, promoted review lessons;
- how enforceable the approved Guardrail set is (enforceable / not-hook-enforceable / malformed).

Label composed prose as auto-composed and unreviewed, and render numbers as authoritative beside
it. Do not present a blended adherence score, and state that advisory rules are not machine-
observable rather than implying they were measured. As everywhere else: no individual ranking, no
hours worked, no per-person attribution.

### Overview (`/overview`)

Show:

- pending Candidate count;
- approved knowledge count and its composition by type;
- open dirty markers.

Session activity is deliberately absent: browsing an activity log is not what this product is for,
and the pages that did it were removed rather than kept for completeness.

Do not show individual ranking, hours worked, prompt count leaderboard, or a productivity score.

### Session detail

Hierarchy:

```text
Session
└── Run
    └── Turn
        ├── Tool summary
        └── Checkpoint
```

Show actor, platform, branch, SHA window, Issue/PR links, changed paths, validation, decisions, unresolved items, and related approved knowledge. Do not show raw conversation.

### Review Queue

The detail view has:

- source Session/Checkpoint/Review;
- candidate type/status/confidence;
- editable title, metadata, and Markdown body;
- rendered preview;
- secret/path/schema validation results;
- possible duplicates/contradictions;
- canonical diff preview;
- approve, reject, supersede actions.

Approval is disabled until validation passes. Guardrail approval requires viewing the machine guard spec.

### Work Graph

Default relation chain:

```text
Issue -> Session -> Commit/PR -> Review -> Knowledge
```

React Flow renders up to 200 nodes per query (the §5 graph cap). Larger graphs use server-side expansion and explicit “load neighbors”. Color encodes entity type, not person performance.

The view described here is built (`apps/dashboard/src/pages/Graph.tsx`) but not good enough to show, so `/graph` renders a coming-soon placeholder instead and issues no relation query. The §5 graph endpoints stay live; knowledge detail is where relations are visible meanwhile.

## 7. Local refresh behavior

Realtime cross-device synchronization is out of scope. Within one dashboard:

- TanStack Query invalidates affected queries after mutation;
- active overview/review pages poll every 5 seconds while visible;
- polling stops when the tab is hidden;
- canonical changes made outside the dashboard appear after explicit Sync or the next lightweight file check;
- no WebSocket or SSE in v0.1.

## 8. Accessibility and localization

- Japanese is the default UI locale; English is included in the message catalog.
- No user-visible string is hard-coded inside domain/API packages.
- WCAG 2.2 AA target for keyboard, focus, contrast, and form errors.
- Graph information has an equivalent table/list representation.
- Charts include text summaries and accessible labels.
- Dates display in the user's local timezone while API values remain UTC.

## 9. Security headers

At minimum:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-store
```

Do not use CDN scripts, remote fonts, `unsafe-eval`, or render unsanitized Markdown HTML. Markdown raw HTML is disabled.

## 10. Tests

### API

- auth exchange and replay rejection;
- cookie/origin/header checks;
- schema validation and unknown-field rejection;
- cursor pagination stability;
- candidate optimistic conflict;
- approve writes canonical first and repairs DB failure;
- path traversal and symlink escape;
- no raw-content endpoints;
- search degradation and graph limits.

### UI

- keyboard-only candidate review/approval;
- Japanese/English rendering;
- loading, empty, error, conflict, and truncated states;
- secret warning blocks approval;
- graph has list alternative;
- individual ranking never appears;
- refresh after mutation;
- direct-route reload from Vite static fallback.

### E2E

Playwright launches `iroha dashboard --no-open`, exchanges a synthetic token, reviews a fixture Candidate, approves it, verifies the canonical file, and reloads the knowledge detail.

