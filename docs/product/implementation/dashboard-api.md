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
- cursor pagination, default 30, maximum 100;
- deterministic sort with ID tie-breaker;
- errors do not contain SQL, stack traces, absolute paths, or secret values;
- all user-visible errors have stable codes.

## 5. Endpoint contract

### Authentication and health

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/exchange` | exchange launch token for cookie |
| `POST` | `/api/auth/logout` | invalidate local session |
| `GET` | `/api/v1/health` | process and DB liveness |
| `GET` | `/api/v1/bootstrap` | repository, user, feature, schema summary |

### Overview and sessions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/overview` | counts, recent Sessions, pending Candidates, unresolved items |
| `GET` | `/api/v1/sessions` | paginated Sessions |
| `GET` | `/api/v1/sessions/:id` | Session, Runs, summary, relations |
| `GET` | `/api/v1/sessions/:id/runs/:runId` | Turns, Tool summaries, Checkpoints |
| `GET` | `/api/v1/checkpoints/:id` | structured Checkpoint detail |

Session filters: platform, actor, status, label, Issue/PR ref, date range, unresolved-only.

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

Approval invokes the exact transaction in `canonical-schema.md`. The API does not accept a target canonical path from the browser; the server derives it from validated type and ID.

### Knowledge and graph

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/knowledge` | approved/local knowledge list |
| `GET` | `/api/v1/knowledge/:id` | body, provenance, relations, revision |
| `GET` | `/api/v1/entities/:id/relations` | bounded neighbors/subgraph |
| `POST` | `/api/v1/graph/query` | graph roots, types, direction, depth |
| `GET` | `/api/v1/graph/path` | bounded path between two IDs |

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
| `PATCH` | `/api/v1/settings/local` | update Git-internal local settings |
| `GET` | `/api/v1/doctor` | capability diagnostics |
| `POST` | `/api/v1/doctor/repair` | explicitly selected safe repair |

Repair operations are allowlisted. The browser cannot run arbitrary shell commands.

## 6. Initial routes and information architecture

```text
/
/sessions
/sessions/:sessionId
/sessions/:sessionId/runs/:runId
/review
/review/:candidateId
/knowledge
/knowledge/:knowledgeId
/search
/graph
/settings
/doctor
```

### Overview

Show:

- pending Candidate count and oldest age;
- Sessions with active/interrupted status;
- unresolved Checkpoint items;
- recent approved knowledge;
- dirty/sync/schema warnings;
- knowledge growth by type over time.

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

React Flow renders up to 100 nodes initially. Larger graphs use server-side expansion and explicit “load neighbors”. Color encodes entity type, not person performance.

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

