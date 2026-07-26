import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  approveCandidate,
  type CandidateClassification,
  type CandidateStatus,
  type Clock,
  doctorRepair,
  ENTITY_TYPES,
  editCandidate,
  getBootstrap,
  getCandidateDetail,
  getCheckpointDetail,
  getEntityRelations,
  getKnowledgeDetail,
  getOverview,
  getRunDetail,
  getSessionDetail,
  getSettings,
  getSyncStatus,
  graphPath,
  graphQuery,
  listCandidateQueue,
  listDashboardSessions,
  listDiagnosticsEvents,
  listKnowledge,
  mcpSearch,
  proposalSchema,
  type RandomSource,
  recordEventForRepository,
  rejectCandidate,
  repositoryConfigSchema,
  runDashboardSync,
  runDoctor,
  supersedeCandidate,
  updateLocalSettings,
  updateSharedConfig,
} from "@iroha/core";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Auth, SESSION_COOKIE } from "./auth.js";
import { failureBody, httpStatusForCode, newRequestId, successBody } from "./envelope.js";
import { securityHeaders } from "./security.js";
import { createStaticHandler } from "./static.js";

export interface AppConfig {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  auth: Auth;
  /** Absolute path to the built SPA (`apps/dashboard/dist`); when set, non-API GETs serve it. */
  staticRoot?: string;
}

interface Variables {
  requestId: string;
  /** Set by whichever branch answers with a failure envelope; read by the diagnostics middleware. */
  errorCode?: string;
}

interface Vars {
  Variables: Variables;
}

// Request-body schemas (strict — an invalid body is a 400 via `defaultHook`).
const actorSchema = z.strictObject({
  provider: z.enum(["git", "github", "gitlab", "local"]),
  displayName: z.string().min(1).max(120),
});

const exchangeSchema = z.strictObject({ token: z.string().min(1).max(512) });
const approveSchema = z.strictObject({
  revisionToken: z.string().min(1),
  actor: actorSchema,
  comment: z.string().max(2000).optional(),
});
const rejectSchema = z.strictObject({
  revisionToken: z.string().min(1),
  reason: z.string().max(2000).optional(),
});
const supersedeSchema = z.strictObject({
  revisionToken: z.string().min(1),
  comment: z.string().max(2000).optional(),
});
const classificationSchema = z.strictObject({
  decisionKind: z.enum(["architecture", "product", "implementation", "process"]).optional(),
  ruleSeverity: z.enum(["info", "warning", "error"]).optional(),
  conceptDomain: z.string().max(120).optional(),
  insightCategory: z.enum(["implementation", "review", "quality", "domain", "process"]).optional(),
  incidentSeverity: z.enum(["low", "medium", "high", "critical"]).optional(),
  incidentResolution: z.enum(["open", "mitigated", "resolved"]).optional(),
  patternMaturity: z.enum(["emerging", "established", "deprecated"]).optional(),
  reviewLearningCategory: z
    .enum(["correctness", "security", "performance", "maintainability", "testing", "product"])
    .optional(),
});
const searchSchema = z.strictObject({
  query: z.string().min(1).max(2000),
  mode: z.enum(["hybrid", "lexical", "vector", "graph"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  includeBody: z.boolean().optional(),
  // Mirrors the MCP `search` tool's filter schema (packages/mcp/src/tools/search.ts)
  // so the dashboard reaches the same hybrid-retrieval filters. A strict object,
  // not `z.record(...)`: the value flows straight into the typed `McpSearchFilters`
  // param, so unvalidated keys must not pass this boundary. `from`/`to` are
  // validated as RFC3339/UTC datetimes here (stricter than the MCP tool's plain
  // string) because `mcpSearch` compares them lexicographically against
  // `entities.updated_at` — a non-datetime would silently mis-window results.
  filters: z
    .strictObject({
      entityTypes: z.array(z.enum(ENTITY_TYPES)).optional(),
      labels: z.array(z.string()).optional(),
      statuses: z.array(z.enum(["approved", "active", "resolved"])).optional(),
      paths: z.array(z.string()).optional(),
      symbols: z.array(z.string()).optional(),
      issueRefs: z.array(z.string()).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      minimumAuthority: z.number().min(0).max(100).optional(),
    })
    .optional(),
});
const graphQuerySchema = z.strictObject({
  roots: z.array(z.string().min(1)).min(1).max(20),
  depth: z.number().int().min(1).max(4).optional(),
});
const localSettingSchema = z.strictObject({ key: z.string().min(1).max(200), value: z.unknown() });
const doctorRepairSchema = z.strictObject({ operation: z.string().min(1).max(64) });
const editSchema = z.strictObject({
  revisionToken: z.string().min(1),
  // The draft is a `KnowledgeProposal` (validated by `proposalSchema` in the
  // handler) plus an optional canonical `classification`; it is validated as a
  // raw object here so the two strict schemas can be applied separately.
  draft: z.record(z.string(), z.unknown()),
});

// A query param may arrive once (a string) or repeated (an array). The SPA sends
// each once, but a duplicated param must not 400 — the query behavior is lenient
// (dashboard-api.md: an invalid or unknown value is ignored, `?from=not-a-date`
// lists unfiltered). So accept the single-or-array shape (a plain `z.string()`
// would reject the array form) and read the first value with `firstOf` in the
// handler, matching the pre-migration `c.req.query()`; the lenient helpers below
// (numOpt/isoOpt/enumOpt) then drop anything invalid. `.catch()` would express
// the leniency directly but is unrepresentable by the OpenAPI generator.
const queryParam = (description: string, example?: string) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .openapi(example === undefined ? { description } : { description, example });

const sessionsQuery = z.object({
  limit: queryParam("Max sessions to return", "50"),
  cursor: queryParam("Opaque pagination cursor"),
  platform: queryParam("claude_code | codex"),
  summaryStatus: queryParam("none | draft | approved"),
  from: queryParam("RFC3339 lower bound compared against last_seen_at"),
  to: queryParam("RFC3339 upper bound compared against last_seen_at"),
});
const candidatesQuery = z.object({
  status: queryParam("pending | approved | rejected | superseded"),
  limit: queryParam("Max candidates to return"),
  cursor: queryParam("Opaque pagination cursor"),
});
// `status`/`type` are repeatable filters read via `c.req.queries()` in the handler
// (`enumArrOpt` keeps the valid values and drops the rest), so they are documented
// in the route `description` rather than as scalar params here.
const knowledgeQuery = z.object({
  limit: queryParam("Max knowledge items to return"),
  cursor: queryParam("Opaque pagination cursor"),
});
const relationsQuery = z.object({ limit: queryParam("Max relations to return") });
const eventsQuery = z.object({ limit: queryParam("Max events to return (1-100, default 30)") });

// The anti-CSRF marker every state-changing request must carry (dashboard-api.md
// §3). Documented on each mutation so a client generated from `/api/doc` sends it
// (without it the `antiCsrf` middleware 403s). Enforcement is the middleware, not
// this schema — the header is always present by the time route validation runs.
const mutationHeaders = z.object({
  "x-iroha-request": z.literal("1").openapi({ description: 'Anti-CSRF marker; must be "1"' }),
});

const idParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const runParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
  runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
});

// Response envelopes for the OpenAPI document (dashboard-api.md §4). Responses
// are not validated at runtime — the handlers answer through `respond()`, whose
// dynamic status the literal-typed response union cannot express — so these
// schemas are documentation only.
const metaSchema = z.object({ requestId: z.string() });
const successEnvelope = z.object({ ok: z.literal(true), data: z.unknown(), meta: metaSchema });
const errorEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    fieldErrors: z.record(z.string(), z.string()),
  }),
  meta: metaSchema,
});
// `respond()` maps each use-case error code to its HTTP status via
// `httpStatusForCode` (404/409/500/503, plus 403 from the anti-CSRF guard), all
// carrying the same failure envelope — documented as a `default` response so the
// spec covers the full error set, not just the two explicit codes.
const RESPONSES = {
  200: { content: { "application/json": { schema: successEnvelope } }, description: "Success" },
  400: { content: { "application/json": { schema: errorEnvelope } }, description: "Invalid input" },
  401: {
    content: { "application/json": { schema: errorEnvelope } },
    description: "Missing or invalid session",
  },
  default: {
    content: { "application/json": { schema: errorEnvelope } },
    description: "Error envelope (403/404/409/500/503 per the error code)",
  },
} as const;

/** A required JSON request body of the given schema. */
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

/** Adds the required anti-CSRF header to a state-changing route's request declaration. */
const withCsrf = <R extends object>(request: R) => ({ headers: mutationHeaders, ...request });

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    fieldErrors[issue.path.join(".") || "_"] = issue.message;
  }
  return fieldErrors;
}

/**
 * Builds the local dashboard Hono app: security headers, cookie session auth,
 * anti-CSRF guard on mutations, and every `/api/v1` endpoint wired to an
 * `@iroha/core` use case. Routes are declared with `@hono/zod-openapi`, which
 * validates each request body/param against its Zod schema and generates the
 * OpenAPI 3.1 document served at `GET /api/doc`. Each endpoint's response `data`
 * shape is the return type of its use case, re-exported from `@iroha/api` for the
 * SPA's typed client (index.ts).
 */
export function createApp(config: AppConfig) {
  const { cwd, clock, random, auth } = config;
  const useCaseCtx = { cwd, clock, random };

  const app = new OpenAPIHono<Vars>({
    // A request that fails Zod validation becomes the standard failure envelope
    // with per-field errors, matching the pre-migration `readJson` behavior.
    defaultHook: (result, c) => {
      if (!result.success) {
        c.set("errorCode", "INVALID_INPUT");
        return c.json(
          failureBody(
            c.get("requestId"),
            { code: "INVALID_INPUT", message: "Request failed validation", retryable: false },
            fieldErrorsOf(result.error),
          ),
          400,
        );
      }
    },
  });

  app.use("*", securityHeaders());
  app.use("*", async (c, next) => {
    c.set("requestId", newRequestId(random));
    await next();
  });

  // Anti-CSRF for every state-changing request (dashboard-api.md §3): exact
  // same-origin, JSON content type, and the custom `X-Iroha-Request` header a
  // cross-site form or `<img>`/`<script>` load can never set.
  const antiCsrf: MiddlewareHandler<Vars> = async (c, next) => {
    const method = c.req.method;
    if (method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT") {
      const origin = c.req.header("Origin");
      const host = c.req.header("Host");
      const sameOrigin = origin !== undefined && host !== undefined && safeHost(origin) === host;
      const jsonType = (c.req.header("Content-Type") ?? "").includes("application/json");
      const marker = c.req.header("X-Iroha-Request") === "1";
      if (!sameOrigin || !jsonType || !marker) {
        c.set("errorCode", "INVALID_INPUT");
        return c.json(
          failureBody(c.get("requestId"), {
            code: "INVALID_INPUT",
            message: "Request failed local anti-CSRF checks",
            retryable: false,
          }),
          403,
        );
      }
    }
    await next();
  };
  app.use("*", antiCsrf);

  const requireCookie: MiddlewareHandler<Vars> = async (c, next) => {
    if (!auth.verify(getCookie(c, SESSION_COOKIE))) {
      c.set("errorCode", "INVALID_SESSION_TOKEN");
      return c.json(
        failureBody(c.get("requestId"), {
          code: "INVALID_SESSION_TOKEN",
          message: "Missing or invalid session",
          retryable: false,
        }),
        401,
      );
    }
    await next();
  };
  app.use("/api/v1/*", requireCookie);
  app.use("/api/auth/logout", requireCookie);

  // One `event_log` row per API request, for the Doctor page's diagnostics list.
  // Registered *after* the auth and anti-CSRF guards so a rejected request costs
  // no repository resolution and no write: before this endpoint existed a 401 did
  // zero I/O, and `event_log` has no pruning, so logging outside the guards would
  // hand any caller that reaches the loopback port an unauthenticated disk-write.
  //
  // A successful read is not recorded. The SPA polls several pages every 5s
  // (dashboard-api.md §7), which fills the whole list with `GET /api/v1/overview`
  // within minutes and hides the rows worth reading — measured: 50 of 50 rows
  // after ~4 minutes on one focused tab. Mutations and failures are what a
  // diagnostics list is for, and they are not periodic.
  //
  // `adapter` is the matched route pattern in the router's own `:id` form, never
  // the concrete URL, so no id, query value, or path from the request is recorded.
  // 4xx is a `warning` — a rejected request is the client's problem, not a
  // malfunction; only 5xx is a `failure`.
  app.use("/api/*", async (c, next) => {
    const startedAt = performance.now();
    await next();
    const status = c.res.status;
    if (status < 400 && (c.req.method === "GET" || c.req.method === "HEAD")) {
      return;
    }
    const errorCode = c.get("errorCode");
    await recordEventForRepository({
      cwd,
      clock,
      random,
      eventType: "api.request",
      adapter: `${c.req.method} ${c.req.routePath}`,
      outcome: status >= 500 ? "failure" : status >= 400 ? "warning" : "success",
      durationMs: Math.round(performance.now() - startedAt),
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  });

  // A thrown handler error (a use case should return a Result, not throw)
  // becomes a clean INTERNAL_ERROR envelope — never a stack trace (§4). The one
  // exception is a request body that is not parseable JSON: `@hono/zod-openapi`'s
  // validator throws an `HTTPException(400)` before `defaultHook` runs, so map it
  // back to the same 400 the pre-migration `readJson` returned rather than a 500.
  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "req_unknown";
    if (err instanceof HTTPException) {
      c.set("errorCode", "INVALID_INPUT");
      return c.json(
        failureBody(requestId, {
          code: "INVALID_INPUT",
          message: "Request body is not valid JSON",
          retryable: false,
        }),
        400,
      );
    }
    c.set("errorCode", "INTERNAL_ERROR");
    return c.json(
      failureBody(requestId, {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error",
        retryable: false,
      }),
      500,
    );
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/auth/exchange",
      tags: ["auth"],
      summary: "Exchange a one-time launch token for a session cookie",
      request: withCsrf(jsonBody(exchangeSchema)),
      responses: RESPONSES,
    }),
    (c) => {
      const rid = c.get("requestId");
      const cookieValue = auth.exchange(c.req.valid("json").token);
      if (cookieValue === null) {
        return fail(
          c,
          {
            code: "INVALID_SESSION_TOKEN",
            message: "Launch token is invalid or already used",
            retryable: false,
          },
          401,
        );
      }
      setCookie(c, SESSION_COOKIE, cookieValue, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        secure: false,
      });
      return ok(c, rid, { authenticated: true });
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/auth/logout",
      tags: ["auth"],
      summary: "Revoke the session cookie",
      request: withCsrf({}),
      responses: RESPONSES,
    }),
    (c) => {
      auth.revoke(getCookie(c, SESSION_COOKIE));
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return ok(c, c.get("requestId"), { authenticated: false });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/health",
      tags: ["system"],
      summary: "Liveness probe",
      responses: RESPONSES,
    }),
    (c) => ok(c, c.get("requestId"), { status: "ok" }),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/bootstrap",
      tags: ["overview"],
      summary: "Initial dashboard bootstrap payload",
      responses: RESPONSES,
    }),
    (c) => respond(c, getBootstrap(useCaseCtx)),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/overview",
      tags: ["overview"],
      summary: "Repository overview metrics",
      responses: RESPONSES,
    }),
    (c) => respond(c, getOverview(useCaseCtx)),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sessions",
      tags: ["sessions"],
      summary: "List agent sessions",
      request: { query: sessionsQuery },
      responses: RESPONSES,
    }),
    (c) => {
      const q = c.req.valid("query");
      return respond(
        c,
        listDashboardSessions({
          ...useCaseCtx,
          ...numOpt("limit", firstOf(q.limit)),
          ...strOpt("cursor", firstOf(q.cursor)),
          ...enumOpt<"claude_code" | "codex">("platform", firstOf(q.platform), [
            "claude_code",
            "codex",
          ]),
          ...enumOpt<"none" | "draft" | "approved">("summaryStatus", firstOf(q.summaryStatus), [
            "none",
            "draft",
            "approved",
          ]),
          ...isoOpt("from", firstOf(q.from)),
          ...isoOpt("to", firstOf(q.to)),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sessions/{id}",
      tags: ["sessions"],
      summary: "Session detail",
      request: { params: idParam },
      responses: RESPONSES,
    }),
    (c) => respond(c, getSessionDetail({ ...useCaseCtx, sessionId: c.req.valid("param").id })),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sessions/{id}/runs/{runId}",
      tags: ["sessions"],
      summary: "Run detail",
      request: { params: runParam },
      responses: RESPONSES,
    }),
    (c) => respond(c, getRunDetail({ ...useCaseCtx, runId: c.req.valid("param").runId })),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/checkpoints/{id}",
      tags: ["sessions"],
      summary: "Checkpoint detail",
      request: { params: idParam },
      responses: RESPONSES,
    }),
    (c) =>
      respond(c, getCheckpointDetail({ ...useCaseCtx, checkpointId: c.req.valid("param").id })),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/candidates",
      tags: ["review"],
      summary: "List the review queue",
      request: { query: candidatesQuery },
      responses: RESPONSES,
    }),
    (c) => {
      const q = c.req.valid("query");
      return respond(
        c,
        listCandidateQueue({
          ...useCaseCtx,
          ...enumOpt<CandidateStatus>("status", firstOf(q.status), [
            "pending",
            "approved",
            "rejected",
            "superseded",
          ]),
          ...numOpt("limit", firstOf(q.limit)),
          ...strOpt("cursor", firstOf(q.cursor)),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/candidates/{id}",
      tags: ["review"],
      summary: "Candidate detail",
      request: { params: idParam },
      responses: RESPONSES,
    }),
    (c) => respond(c, getCandidateDetail({ ...useCaseCtx, candidateId: c.req.valid("param").id })),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/candidates/{id}",
      tags: ["review"],
      summary: "Edit a candidate draft",
      request: withCsrf({ params: idParam, ...jsonBody(editSchema) }),
      responses: RESPONSES,
    }),
    (c) => {
      const body = c.req.valid("json");
      const { classification: rawClassification, ...proposalPart } = body.draft;
      const proposalParsed = proposalSchema.safeParse(proposalPart);
      if (!proposalParsed.success) {
        return fail(
          c,
          { code: "INVALID_INPUT", message: "Draft failed validation", retryable: false },
          400,
          fieldErrorsOf(proposalParsed.error),
        );
      }
      let classification: CandidateClassification | undefined;
      if (rawClassification !== undefined) {
        const clsParsed = classificationSchema.safeParse(rawClassification);
        if (!clsParsed.success) {
          return fail(
            c,
            {
              code: "INVALID_INPUT",
              message: "Classification failed validation",
              retryable: false,
            },
            400,
            fieldErrorsOf(clsParsed.error),
          );
        }
        // Zod `.optional()` widens each field to `T | undefined`; the runtime
        // object omits absent keys, so it is a valid `CandidateClassification`.
        classification = clsParsed.data as CandidateClassification;
      }
      return respond(
        c,
        editCandidate({
          ...useCaseCtx,
          candidateId: c.req.valid("param").id,
          revisionToken: body.revisionToken,
          draft: { ...proposalParsed.data, ...(classification ? { classification } : {}) },
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/candidates/{id}/approve",
      tags: ["review"],
      summary: "Approve a candidate into canonical knowledge",
      request: withCsrf({ params: idParam, ...jsonBody(approveSchema) }),
      responses: RESPONSES,
    }),
    (c) => {
      const body = c.req.valid("json");
      return respond(
        c,
        approveCandidate({
          ...useCaseCtx,
          candidateId: c.req.valid("param").id,
          revisionToken: body.revisionToken,
          actor: body.actor,
          ...(body.comment !== undefined ? { comment: body.comment } : {}),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/candidates/{id}/reject",
      tags: ["review"],
      summary: "Reject a candidate",
      request: withCsrf({ params: idParam, ...jsonBody(rejectSchema) }),
      responses: RESPONSES,
    }),
    (c) => {
      const body = c.req.valid("json");
      return respond(
        c,
        rejectCandidate({
          ...useCaseCtx,
          candidateId: c.req.valid("param").id,
          revisionToken: body.revisionToken,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/candidates/{id}/supersede",
      tags: ["review"],
      summary: "Supersede a candidate",
      request: withCsrf({ params: idParam, ...jsonBody(supersedeSchema) }),
      responses: RESPONSES,
    }),
    (c) => {
      const body = c.req.valid("json");
      return respond(
        c,
        supersedeCandidate({
          ...useCaseCtx,
          candidateId: c.req.valid("param").id,
          revisionToken: body.revisionToken,
          ...(body.comment !== undefined ? { comment: body.comment } : {}),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/knowledge",
      tags: ["knowledge"],
      summary: "List approved knowledge",
      description:
        "Repeatable `status` (approved|superseded|archived) and `type` (entity type) filters narrow the list; invalid values are ignored.",
      request: { query: knowledgeQuery },
      responses: RESPONSES,
    }),
    (c) => {
      const q = c.req.valid("query");
      return respond(
        c,
        listKnowledge({
          ...useCaseCtx,
          ...numOpt("limit", firstOf(q.limit)),
          ...strOpt("cursor", firstOf(q.cursor)),
          ...enumArrOpt("statuses", c.req.queries("status"), [
            "approved",
            "superseded",
            "archived",
          ]),
          ...enumArrOpt("entityTypes", c.req.queries("type"), [
            "decision",
            "rule",
            "concept",
            "insight",
            "incident",
            "pattern",
            "review_learning",
          ]),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/knowledge/{id}",
      tags: ["knowledge"],
      summary: "Knowledge detail",
      request: { params: idParam },
      responses: RESPONSES,
    }),
    (c) => respond(c, getKnowledgeDetail({ ...useCaseCtx, entityId: c.req.valid("param").id })),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/entities/{id}/relations",
      tags: ["graph"],
      summary: "Direct relations of an entity",
      request: { params: idParam, query: relationsQuery },
      responses: RESPONSES,
    }),
    (c) =>
      respond(
        c,
        getEntityRelations({
          ...useCaseCtx,
          entityId: c.req.valid("param").id,
          ...numOpt("limit", firstOf(c.req.valid("query").limit)),
        }),
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/graph/query",
      tags: ["graph"],
      summary: "Expand the graph from root entities",
      request: withCsrf(jsonBody(graphQuerySchema)),
      responses: RESPONSES,
    }),
    (c) => {
      const body = c.req.valid("json");
      return respond(
        c,
        graphQuery({
          ...useCaseCtx,
          roots: body.roots,
          ...(body.depth !== undefined ? { depth: body.depth } : {}),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/graph/path",
      tags: ["graph"],
      summary: "Shortest path between two entities",
      description: "Required query params `from` and `to` (entity ids).",
      responses: RESPONSES,
    }),
    // `from`/`to` are required and read directly (an empty string is a valid,
    // if empty-result, id — not a 400), so this route parses them by hand rather
    // than through a scalar query schema.
    (c) => {
      const from = c.req.query("from");
      const to = c.req.query("to");
      if (from === undefined || to === undefined) {
        return fail(
          c,
          { code: "INVALID_INPUT", message: "from and to are required", retryable: false },
          400,
        );
      }
      return respond(c, graphPath({ ...useCaseCtx, fromId: from, toId: to }));
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/search",
      tags: ["search"],
      summary: "Hybrid retrieval over the knowledge graph",
      request: withCsrf(jsonBody(searchSchema)),
      responses: RESPONSES,
    }),
    (c) => {
      const body = c.req.valid("json");
      return respond(
        c,
        mcpSearch({
          ...useCaseCtx,
          query: body.query,
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
          ...(body.includeBody !== undefined ? { includeBody: body.includeBody } : {}),
          ...(body.filters !== undefined ? { filters: body.filters } : {}),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/sync",
      tags: ["sync"],
      summary: "Reconcile the index with the canonical files (not a full rebuild)",
      request: withCsrf({}),
      responses: RESPONSES,
    }),
    (c) => respond(c, runDashboardSync(useCaseCtx)),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/sync/status",
      tags: ["sync"],
      summary: "Canonical sync status",
      responses: RESPONSES,
    }),
    (c) => respond(c, getSyncStatus(useCaseCtx)),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/settings",
      tags: ["settings"],
      summary: "Read shared and local settings",
      responses: RESPONSES,
    }),
    (c) => respond(c, getSettings(useCaseCtx)),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/settings/shared",
      tags: ["settings"],
      summary: "Update the git-tracked shared config",
      request: withCsrf(jsonBody(repositoryConfigSchema)),
      responses: RESPONSES,
    }),
    (c) => respond(c, updateSharedConfig({ ...useCaseCtx, config: c.req.valid("json") })),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/settings/local",
      tags: ["settings"],
      summary: "Update a local (untracked) setting",
      request: withCsrf(jsonBody(localSettingSchema)),
      responses: RESPONSES,
    }),
    (c) => {
      const body = c.req.valid("json");
      return respond(c, updateLocalSettings({ ...useCaseCtx, key: body.key, value: body.value }));
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/doctor",
      tags: ["doctor"],
      summary: "Run environment diagnostics",
      responses: RESPONSES,
    }),
    (c) => respond(c, runDoctor(cwd)),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/events",
      tags: ["doctor"],
      summary: "List recent local diagnostics events",
      request: { query: eventsQuery },
      responses: RESPONSES,
    }),
    (c) => {
      const query = c.req.valid("query");
      return respond(
        c,
        listDiagnosticsEvents({
          ...useCaseCtx,
          ...numOpt("limit", firstOf(query.limit)),
        }),
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/doctor/repair",
      tags: ["doctor"],
      summary: "Apply a diagnostic repair operation",
      request: withCsrf(jsonBody(doctorRepairSchema)),
      responses: RESPONSES,
    }),
    (c) => respond(c, doctorRepair({ ...useCaseCtx, operation: c.req.valid("json").operation })),
  );

  // The OpenAPI 3.1 document for every `.openapi()` route above. Unauthenticated
  // by design: it is the API's shape (paths, request schemas) with no repository
  // data or secrets, on a loopback-only server — the same openness as
  // `/api/auth/exchange`. Registered with `.get()` so it does not describe itself.
  app.get("/api/doc", (c) =>
    c.json(
      app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "iroha dashboard API",
          version: "0.1.0",
          description: "Local, loopback-only API for the iroha dashboard (dashboard-api.md).",
        },
      }),
    ),
  );

  // Serve the built SPA (+ SPA fallback) for everything that is not an API route.
  if (config.staticRoot !== undefined) {
    app.get("*", createStaticHandler(config.staticRoot));
  }

  return app;
}

export type AppType = ReturnType<typeof createApp>;

/**
 * Renders an `@iroha/core` use-case Result as the success/failure envelope.
 * Returns `never` because the envelope's HTTP status is chosen at runtime from
 * the use case's error code — a dynamic status the literal-typed `responses`
 * union of `@hono/zod-openapi` cannot express. The SPA reads this runtime
 * envelope (client.ts), not RPC response types, so the single cast here keeps
 * every handler free of per-route response typing.
 */
async function respond<T>(
  c: Context<Vars>,
  resultPromise: Promise<
    | { ok: true; value: T }
    | { ok: false; error: { code: string; message: string; retryable: boolean } }
  >,
): Promise<never> {
  const requestId = c.get("requestId");
  const result = await resultPromise;
  if (!result.ok) {
    c.set("errorCode", result.error.code);
    return c.json(
      failureBody(requestId, result.error),
      httpStatusForCode(result.error.code) as ContentfulStatusCode,
    ) as never;
  }
  return c.json(successBody(requestId, result.value)) as never;
}

/** Success envelope for handlers that do not front a use case (see `respond`). */
function ok<T>(c: Context<Vars>, requestId: string, data: T): never {
  return c.json(successBody(requestId, data)) as never;
}

/** Failure envelope for in-handler validation/auth branches (see `respond`). */
function fail(
  c: Context<Vars>,
  error: { code: string; message: string; retryable: boolean },
  status: ContentfulStatusCode,
  fieldErrors?: Record<string, string>,
): never {
  c.set("errorCode", error.code);
  return c.json(failureBody(c.get("requestId"), error, fieldErrors), status) as never;
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** The first value of a query param that Hono may hand back as a string or an array. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function strOpt(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

/** Like `strOpt`, but drops a value that is not an RFC 3339 datetime (mirrors the search route's `from`/`to`). */
function isoOpt(key: string, value: string | undefined): Record<string, string> {
  return value !== undefined && z.iso.datetime().safeParse(value).success ? { [key]: value } : {};
}

function numOpt(key: string, value: string | undefined): Record<string, number> {
  if (value === undefined) return {};
  const n = Number(value);
  return Number.isFinite(n) ? { [key]: n } : {};
}

function enumOpt<T extends string>(
  key: string,
  value: string | undefined,
  allowed: readonly T[],
): Record<string, T> {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? { [key]: value as T }
    : {};
}

/** Multi-value filter: keeps only allowed values from a repeated query param, omitting the key when none remain. */
function enumArrOpt<T extends string>(
  key: string,
  values: string[] | undefined,
  allowed: readonly T[],
): Record<string, T[]> {
  if (values === undefined) return {};
  const filtered = values.filter((v): v is T => (allowed as readonly string[]).includes(v));
  return filtered.length > 0 ? { [key]: filtered } : {};
}
