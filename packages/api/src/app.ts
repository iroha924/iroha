import {
  approveCandidate,
  type CandidateClassification,
  type CandidateStatus,
  type Clock,
  doctorRepair,
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
  listKnowledge,
  mcpSearch,
  proposalSchema,
  type RandomSource,
  rejectCandidate,
  repositoryConfigSchema,
  runDashboardSync,
  runDoctor,
  supersedeCandidate,
  updateLocalSettings,
  updateSharedConfig,
} from "@iroha/core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type Auth, SESSION_COOKIE } from "./auth.js";
import { failureBody, httpStatusForCode, newRequestId, successBody } from "./envelope.js";
import { securityHeaders } from "./security.js";

export interface AppConfig {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  auth: Auth;
}

interface Variables {
  requestId: string;
}

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
  filters: z.record(z.string(), z.unknown()).optional(),
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
 * `@iroha/core` use case. Each endpoint's response `data` shape is the return
 * type of its use case, re-exported from `@iroha/api` for the SPA's typed
 * client (index.ts).
 */
export function createApp(config: AppConfig) {
  const { cwd, clock, random, auth } = config;
  const useCaseCtx = { cwd, clock, random };

  const app = new Hono<{ Variables: Variables }>();

  app.use("*", securityHeaders());
  app.use("*", async (c, next) => {
    c.set("requestId", newRequestId(random));
    await next();
  });

  // Anti-CSRF for every state-changing request (dashboard-api.md §3): exact
  // same-origin, JSON content type, and the custom `X-Iroha-Request` header a
  // cross-site form or `<img>`/`<script>` load can never set.
  const antiCsrf: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const method = c.req.method;
    if (method === "POST" || method === "PATCH" || method === "DELETE" || method === "PUT") {
      const origin = c.req.header("Origin");
      const host = c.req.header("Host");
      const sameOrigin = origin !== undefined && host !== undefined && safeHost(origin) === host;
      const jsonType = (c.req.header("Content-Type") ?? "").includes("application/json");
      const marker = c.req.header("X-Iroha-Request") === "1";
      if (!sameOrigin || !jsonType || !marker) {
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

  const requireCookie: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    if (!auth.verify(getCookie(c, SESSION_COOKIE))) {
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

  // A thrown handler error (a use case should return a Result, not throw)
  // becomes a clean INTERNAL_ERROR envelope — never a stack trace (§4).
  app.onError((_err, c) =>
    c.json(
      failureBody(c.get("requestId") ?? "req_unknown", {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error",
        retryable: false,
      }),
      500,
    ),
  );

  const routes = app
    .post("/api/auth/exchange", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, exchangeSchema, rid);
      if (!body.ok) return body.res;
      const cookieValue = auth.exchange(body.value.token);
      if (cookieValue === null) {
        return c.json(
          failureBody(rid, {
            code: "INVALID_SESSION_TOKEN",
            message: "Launch token is invalid or already used",
            retryable: false,
          }),
          401,
        );
      }
      setCookie(c, SESSION_COOKIE, cookieValue, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        secure: false,
      });
      return c.json(successBody(rid, { authenticated: true }));
    })
    .post("/api/auth/logout", (c) => {
      auth.revoke(getCookie(c, SESSION_COOKIE));
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json(successBody(c.get("requestId"), { authenticated: false }));
    })
    .get("/api/v1/health", (c) => c.json(successBody(c.get("requestId"), { status: "ok" })))
    .get("/api/v1/bootstrap", (c) => respond(c, getBootstrap(useCaseCtx)))
    .get("/api/v1/overview", (c) => respond(c, getOverview(useCaseCtx)))
    .get("/api/v1/sessions", (c) =>
      respond(
        c,
        listDashboardSessions({
          ...useCaseCtx,
          ...numOpt("limit", c.req.query("limit")),
          ...strOpt("cursor", c.req.query("cursor")),
          ...enumOpt<"claude_code" | "codex">("platform", c.req.query("platform"), [
            "claude_code",
            "codex",
          ]),
          ...enumOpt<"none" | "draft" | "approved">("summaryStatus", c.req.query("summaryStatus"), [
            "none",
            "draft",
            "approved",
          ]),
          ...strOpt("from", c.req.query("from")),
          ...strOpt("to", c.req.query("to")),
        }),
      ),
    )
    .get("/api/v1/sessions/:id", (c) =>
      respond(c, getSessionDetail({ ...useCaseCtx, sessionId: c.req.param("id") })),
    )
    .get("/api/v1/sessions/:id/runs/:runId", (c) =>
      respond(c, getRunDetail({ ...useCaseCtx, runId: c.req.param("runId") })),
    )
    .get("/api/v1/checkpoints/:id", (c) =>
      respond(c, getCheckpointDetail({ ...useCaseCtx, checkpointId: c.req.param("id") })),
    )
    .get("/api/v1/candidates", (c) =>
      respond(
        c,
        listCandidateQueue({
          ...useCaseCtx,
          ...enumOpt<CandidateStatus>("status", c.req.query("status"), [
            "pending",
            "approved",
            "rejected",
            "superseded",
          ]),
          ...numOpt("limit", c.req.query("limit")),
          ...strOpt("cursor", c.req.query("cursor")),
        }),
      ),
    )
    .get("/api/v1/candidates/:id", (c) =>
      respond(c, getCandidateDetail({ ...useCaseCtx, candidateId: c.req.param("id") })),
    )
    .patch("/api/v1/candidates/:id", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, editSchema, rid);
      if (!body.ok) return body.res;
      const { classification: rawClassification, ...proposalPart } = body.value.draft;
      const proposalParsed = proposalSchema.safeParse(proposalPart);
      if (!proposalParsed.success) {
        return c.json(
          failureBody(
            rid,
            { code: "INVALID_INPUT", message: "Draft failed validation", retryable: false },
            fieldErrorsOf(proposalParsed.error),
          ),
          400,
        );
      }
      let classification: CandidateClassification | undefined;
      if (rawClassification !== undefined) {
        const clsParsed = classificationSchema.safeParse(rawClassification);
        if (!clsParsed.success) {
          return c.json(
            failureBody(
              rid,
              {
                code: "INVALID_INPUT",
                message: "Classification failed validation",
                retryable: false,
              },
              fieldErrorsOf(clsParsed.error),
            ),
            400,
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
          candidateId: c.req.param("id"),
          revisionToken: body.value.revisionToken,
          draft: { ...proposalParsed.data, ...(classification ? { classification } : {}) },
        }),
      );
    })
    .post("/api/v1/candidates/:id/approve", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, approveSchema, rid);
      if (!body.ok) return body.res;
      return respond(
        c,
        approveCandidate({
          ...useCaseCtx,
          candidateId: c.req.param("id"),
          revisionToken: body.value.revisionToken,
          actor: body.value.actor,
          ...(body.value.comment !== undefined ? { comment: body.value.comment } : {}),
        }),
      );
    })
    .post("/api/v1/candidates/:id/reject", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, rejectSchema, rid);
      if (!body.ok) return body.res;
      return respond(
        c,
        rejectCandidate({
          ...useCaseCtx,
          candidateId: c.req.param("id"),
          revisionToken: body.value.revisionToken,
          ...(body.value.reason !== undefined ? { reason: body.value.reason } : {}),
        }),
      );
    })
    .post("/api/v1/candidates/:id/supersede", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, supersedeSchema, rid);
      if (!body.ok) return body.res;
      return respond(
        c,
        supersedeCandidate({
          ...useCaseCtx,
          candidateId: c.req.param("id"),
          revisionToken: body.value.revisionToken,
          ...(body.value.comment !== undefined ? { comment: body.value.comment } : {}),
        }),
      );
    })
    .get("/api/v1/knowledge", (c) =>
      respond(
        c,
        listKnowledge({
          ...useCaseCtx,
          ...numOpt("limit", c.req.query("limit")),
          ...strOpt("cursor", c.req.query("cursor")),
        }),
      ),
    )
    .get("/api/v1/knowledge/:id", (c) =>
      respond(c, getKnowledgeDetail({ ...useCaseCtx, entityId: c.req.param("id") })),
    )
    .get("/api/v1/entities/:id/relations", (c) =>
      respond(
        c,
        getEntityRelations({
          ...useCaseCtx,
          entityId: c.req.param("id"),
          ...numOpt("limit", c.req.query("limit")),
        }),
      ),
    )
    .post("/api/v1/graph/query", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, graphQuerySchema, rid);
      if (!body.ok) return body.res;
      return respond(
        c,
        graphQuery({
          ...useCaseCtx,
          roots: body.value.roots,
          ...(body.value.depth !== undefined ? { depth: body.value.depth } : {}),
        }),
      );
    })
    .get("/api/v1/graph/path", async (c) => {
      const from = c.req.query("from");
      const to = c.req.query("to");
      if (from === undefined || to === undefined) {
        return c.json(
          failureBody(c.get("requestId"), {
            code: "INVALID_INPUT",
            message: "from and to are required",
            retryable: false,
          }),
          400,
        );
      }
      return respond(c, graphPath({ ...useCaseCtx, fromId: from, toId: to }));
    })
    .post("/api/v1/search", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, searchSchema, rid);
      if (!body.ok) return body.res;
      return respond(
        c,
        mcpSearch({
          ...useCaseCtx,
          query: body.value.query,
          ...(body.value.mode !== undefined ? { mode: body.value.mode } : {}),
          ...(body.value.limit !== undefined ? { limit: body.value.limit } : {}),
          ...(body.value.includeBody !== undefined ? { includeBody: body.value.includeBody } : {}),
        }),
      );
    })
    .get("/api/v1/search/suggestions", (c) =>
      c.json(successBody(c.get("requestId"), { suggestions: [] as string[] })),
    )
    .post("/api/v1/sync", (c) => respond(c, runDashboardSync(useCaseCtx)))
    .get("/api/v1/sync/status", (c) => respond(c, getSyncStatus(useCaseCtx)))
    .get("/api/v1/settings", (c) => respond(c, getSettings(useCaseCtx)))
    .patch("/api/v1/settings/shared", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, repositoryConfigSchema, rid);
      if (!body.ok) return body.res;
      return respond(c, updateSharedConfig({ ...useCaseCtx, config: body.value }));
    })
    .patch("/api/v1/settings/local", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, localSettingSchema, rid);
      if (!body.ok) return body.res;
      return respond(
        c,
        updateLocalSettings({ ...useCaseCtx, key: body.value.key, value: body.value.value }),
      );
    })
    .get("/api/v1/doctor", (c) => respond(c, runDoctor(cwd)))
    .post("/api/v1/doctor/repair", async (c) => {
      const rid = c.get("requestId");
      const body = await readJson(c, doctorRepairSchema, rid);
      if (!body.ok) return body.res;
      return respond(c, doctorRepair({ ...useCaseCtx, operation: body.value.operation }));
    });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function strOpt(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
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

async function readJson<T extends z.ZodType>(
  c: Context<{ Variables: Variables }>,
  schema: T,
  requestId: string,
): Promise<{ ok: true; value: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      res: c.json(
        failureBody(requestId, {
          code: "INVALID_INPUT",
          message: "Request body is not valid JSON",
          retryable: false,
        }),
        400,
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json(
        failureBody(
          requestId,
          { code: "INVALID_INPUT", message: "Request failed validation", retryable: false },
          fieldErrorsOf(parsed.error),
        ),
        400,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

async function respond<T>(
  c: Context<{ Variables: Variables }>,
  resultPromise: Promise<
    | { ok: true; value: T }
    | { ok: false; error: { code: string; message: string; retryable: boolean } }
  >,
): Promise<Response> {
  const requestId = c.get("requestId");
  const result = await resultPromise;
  if (!result.ok) {
    return c.json(
      failureBody(requestId, result.error),
      httpStatusForCode(result.error.code) as ContentfulStatusCode,
    );
  }
  return c.json(successBody(requestId, result.value));
}
