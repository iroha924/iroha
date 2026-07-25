import type { RelationType } from "@iroha/storage";

/**
 * The search-evaluation corpus and query set (database-schema.md §14). It is a
 * synthetic, deterministic `.iroha`-shaped knowledge base about a fictional
 * payments platform: relevant docs carry distinctive terms for the lexical/
 * vector path, scope for the scope boost, and relations for the graph path,
 * plus `dist_*` distractor docs that compete for top-10 slots. The distractors
 * are deliberately strong enough that a few relevant docs fall just outside
 * top-10 (so Recall@10 is not structurally 1.0) — the eval gate measures that,
 * it does not assume every relevant doc is recalled. Entity ids are readable and
 * stable so `queries.relevant` can reference them; `entities.id` has no format
 * constraint in the schema.
 */

type FixtureDocType =
  | "decision"
  | "rule"
  | "concept"
  | "insight"
  | "incident"
  | "pattern"
  | "review_learning";

export interface FixtureDoc {
  id: string;
  type: FixtureDocType;
  title: string;
  summary: string;
  body: string;
  scope?: { paths?: string[]; symbols?: string[] };
  labels?: string[];
  sources?: { type: string; ref: string }[];
  enforcement?: "advisory" | "guardrail";
}

export interface FixtureRelation {
  from: string;
  to: string;
  type: RelationType;
}

export type QueryClass = "ja-nl" | "en-nl" | "code" | "relationship";

export interface FixtureQuery {
  id: string;
  class: QueryClass;
  text: string;
  relevant: string[];
  scope?: { paths?: string[]; symbols?: string[]; issueRefs?: string[] };
  /** Approved Guardrail/Rule ids that MUST appear in the top-10 (Rule Recall@10 = 1.00 gate). */
  applicableRuleIds?: string[];
}

export const DOCS: FixtureDoc[] = [
  {
    id: "dec_repo_pattern",
    type: "decision",
    title: "Use the repository pattern for all libSQL access",
    summary: "Typed repository functions wrap every SQL query; no ORM.",
    body: "All database access goes through typed repository functions that wrap parameterized SQL. We do not use an ORM. This keeps the query surface auditable and the domain layer independent of the database driver.",
    scope: { paths: ["packages/storage/**"], symbols: ["upsertEntity"] },
    labels: ["storage", "architecture"],
    sources: [{ type: "pull_request", ref: "PR-12" }],
  },
  {
    id: "dec_libsql",
    type: "decision",
    title: "Use libSQL as the local operational index",
    summary: "libSQL is a rebuildable local index, not the source of truth.",
    body: "The local index is libSQL (SQLite-compatible). It is disposable and rebuildable from the canonical .iroha files, so it is never the sole source of approved knowledge.",
    scope: { paths: ["packages/storage/**"] },
    labels: ["storage"],
    sources: [{ type: "document", ref: "design.md#storage" }],
  },
  {
    id: "dec_rrf",
    type: "decision",
    title: "Hybrid search fuses candidates with Reciprocal Rank Fusion",
    summary: "Unicode FTS, trigram FTS and vector candidates are combined with RRF.",
    body: "Search combines unicode full-text, trigram full-text and vector candidates using Reciprocal Rank Fusion, then applies authority, scope and graph boosts. Recency is a bounded tie-breaker only.",
    scope: { paths: ["packages/search/**"], symbols: ["searchHybrid"] },
    labels: ["search"],
  },
  {
    id: "dec_voyage",
    type: "decision",
    title: "Optional Voyage embeddings with voyage-4-large at 1024 dimensions",
    summary: "Embedding is optional; zero-config is FTS-only.",
    body: "Vector embeddings are optional and use the Voyage voyage-4-large model at 1024 dimensions. When no API key is configured the search degrades to full-text and graph only.",
    scope: { paths: ["packages/search/**"] },
    labels: ["search", "embedding"],
  },
  {
    id: "dec_esm",
    type: "decision",
    title: "ESM-only TypeScript bundled with tsdown",
    summary: "All packages are ESM; tsdown produces the Node bundles.",
    body: "The codebase is ESM-only TypeScript. tsdown (rolldown) builds the distributable Node bundles and tsc is used only for type-checking.",
    labels: ["build"],
  },
  {
    id: "dec_forge_p1",
    type: "decision",
    title: "GitHub Forge integration is P1 and follows the offline slice",
    summary: "GitHub is the first Forge provider, scheduled after the vertical slice.",
    body: "Forge integration with GitHub is a P1 feature that follows the offline vertical slice. Forge failure must never fail canonical sync.",
    labels: ["forge"],
  },
  {
    id: "rul_gen_readonly",
    type: "rule",
    enforcement: "guardrail",
    title: "Never edit generated files under src/generated",
    summary: "Files in src/generated are produced by codegen and are read-only.",
    body: "Files under src/generated are produced by the code generator and must not be edited by hand. Change the generator input instead.",
    scope: { paths: ["src/generated/**"] },
    labels: ["guardrail", "codegen"],
  },
  {
    id: "rul_payments_test",
    type: "rule",
    enforcement: "guardrail",
    title: "Run the payment tests before changing the payments service",
    summary: "Any change under src/payments requires the payment test suite.",
    body: "Any change to the payments service under src/payments must be accompanied by running the payment test suite before commit.",
    scope: { paths: ["src/payments/**"], symbols: ["charge"] },
    labels: ["guardrail", "payments"],
  },
  {
    id: "rul_no_secret_log",
    type: "rule",
    enforcement: "advisory",
    title: "Never log credentials or secret values",
    summary: "Credentials must never appear in logs or error messages.",
    body: "Credentials, tokens and connection strings must never be written to logs or error messages. Redact before logging.",
    labels: ["security"],
  },
  {
    id: "con_provenance",
    type: "concept",
    title: "Provenance-first knowledge",
    summary: "Every approved item carries at least one source reference.",
    body: "Provenance-first means every approved knowledge item links back to at least one source: a session, pull request, commit or document. Knowledge without provenance is not approved.",
    labels: ["concept"],
  },
  {
    id: "con_authority",
    type: "concept",
    title: "Authority scoring tiers",
    summary: "Approved canonical is 100, verified Git/Forge 80, checkpoint 60.",
    body: "Authority scores rank sources: approved canonical knowledge is 100, verified Git or Forge artifacts are 80, local checkpoints are 60, and pending candidates are 30.",
    labels: ["concept", "search"],
  },
  {
    id: "ins_retry_budget",
    type: "insight",
    title: "Retry budget must be well under the job timeout",
    summary: "Total retry time should stay under half the CI job timeout.",
    body: "A network retry budget must be well under the surrounding job timeout, so a single slow provider call cannot get the whole job killed. Keep total retry time under half the timeout.",
    labels: ["ci", "reliability"],
  },
  {
    id: "ins_windows_lock",
    type: "insight",
    title: "Windows keeps a WAL file lock after close",
    summary: "SQLite WAL exclusive lock lingers after close on Windows.",
    body: "On Windows the SQLite WAL exclusive lock can linger after the connection closes, so an immediate file rename or delete fails with EBUSY. This is not fixable from application code.",
    labels: ["windows", "storage"],
  },
  {
    id: "inc_payment_outage",
    type: "incident",
    title: "Payment gateway timeout outage",
    summary: "The payment gateway timed out under load, dropping charges.",
    body: "The payment gateway timed out under load and dropped charge requests. Mitigation added bounded retries with backoff around the charge call.",
    scope: { paths: ["src/payments/**"], symbols: ["charge"] },
    labels: ["incident", "payments"],
  },
  {
    id: "pat_result_type",
    type: "pattern",
    title: "Return Result<T,E> instead of throwing across boundaries",
    summary: "Public functions return a Result rather than throwing.",
    body: "Every function that crosses a package boundary returns a Result<T,E> value rather than throwing. Exceptions are only used for internal invariants that never escape a module.",
    labels: ["pattern", "errors"],
  },
  {
    id: "pat_zod_boundary",
    type: "pattern",
    title: "Validate every external boundary with Zod",
    summary: "External input is parsed with Zod safeParse at the boundary.",
    body: "All external input — hook payloads, API responses, config files — is validated with a Zod schema using safeParse at the boundary, and mapped to a Result error on failure.",
    labels: ["pattern", "validation"],
  },
  {
    id: "rev_secret_redaction",
    type: "review_learning",
    title: "Redact every free-text field before persisting",
    summary: "Enumerate all unconstrained free-text fields when redacting.",
    body: "When redacting secrets before persistence, enumerate every unconstrained free-text field including command strings and URLs with userinfo, not only prose fields.",
    labels: ["review", "security"],
    sources: [{ type: "review", ref: "REV-7" }],
  },
  {
    id: "rev_path_safety",
    type: "review_learning",
    title: "Resolve symlinks before collapsing dot-dot segments",
    summary: "Never lexically collapse .. before resolving symlinks.",
    body: "Path validation must resolve symlinks before collapsing dot-dot segments, otherwise a symlink pointing outside the repository can escape the boundary check. Delegate to fs.realpath.",
    labels: ["review", "security"],
  },
  {
    id: "dec_hooks_failopen",
    type: "decision",
    title: "Hook internal failure is fail-open",
    summary: "A hook that fails internally exits zero and blocks nothing.",
    body: "When a hook fails internally it exits zero and does not block the action, unless an approved guardrail explicitly denies it. Hard enforcement belongs in CI, not the hook.",
    labels: ["hooks"],
  },
  {
    id: "dec_turn_checkpoint",
    type: "decision",
    title: "Use the Turn and Checkpoint lifecycle, not session-end summaries",
    summary: "Structured checkpoints replace session-end-only summarization.",
    body: "Knowledge is captured through structured Turn and Checkpoint events during work, not a single session-end summary, because Codex has no session-end hook.",
    labels: ["lifecycle"],
  },
  {
    id: "con_guardrail_advisory",
    type: "concept",
    title: "Advisory rules versus enforceable guardrails",
    summary: "Advisory rules are injected as text; guardrails are machine-checked.",
    body: "Advisory rules are natural-language guidance injected into context. Guardrails are machine-enforceable specifications evaluated at PreToolUse. The two are different types.",
    labels: ["concept", "guardrail"],
  },
  {
    id: "ins_fts_trigram",
    type: "insight",
    title: "Japanese search relies on the trigram FTS index",
    summary: "CJK text is matched through the trigram tokenizer.",
    body: "Japanese and other CJK text is matched through the trigram full-text index, while the unicode61 index handles English words and code identifiers.",
    labels: ["search", "i18n"],
  },
  {
    id: "dec_no_daemon",
    type: "decision",
    title: "No background daemon in v0.1",
    summary: "Hooks do bounded local database work; there is no daemon.",
    body: "Version 0.1 has no long-running daemon. Hooks perform only bounded local database operations and never make remote calls.",
    labels: ["architecture"],
  },
  {
    id: "dec_dashboard_auth",
    type: "decision",
    title: "Dashboard authenticates via a launch-token cookie",
    summary: "A one-time URL fragment is exchanged for an HttpOnly cookie.",
    body: "The dashboard binds to loopback and authenticates with a one-time launch token in the URL fragment, exchanged for a process-lifetime HttpOnly SameSite=Strict cookie.",
    scope: { paths: ["apps/dashboard/**"] },
    labels: ["dashboard", "security"],
  },
  {
    id: "pat_atomic_write",
    type: "pattern",
    title: "Write canonical files with an atomic rename",
    summary: "Write to a temp sibling then atomically rename into place.",
    body: "Canonical files are written to a temporary sibling file, flushed, then atomically renamed into place so a crash never leaves a half-written document.",
    labels: ["pattern", "durability"],
  },
  {
    id: "inc_ci_flake",
    type: "incident",
    title: "Windows CI flake from lingering file locks",
    summary: "Windows CI intermittently failed on database file cleanup.",
    body: "Windows CI intermittently failed cleaning up database files because of lingering WAL locks. Windows was demoted to Tier 2 and excluded from the required matrix.",
    labels: ["ci", "windows"],
  },
  {
    id: "rev_locale_stderr",
    type: "review_learning",
    title: "Parse subprocess stderr independent of locale",
    summary: "Force C locale before matching CLI error messages.",
    body: "When classifying a subprocess error from its stderr text, force the C locale (LC_ALL, LANG) and clear LANGUAGE, otherwise a translated message breaks the match.",
    labels: ["review", "subprocess"],
  },
  {
    id: "con_memory_graph",
    type: "concept",
    title: "The Engineering Memory Graph",
    summary: "Sessions, issues, commits, reviews and knowledge form one graph.",
    body: "iroha links sessions, issues, commits, pull requests, reviews and knowledge into a single engineering memory graph so decisions can be traced back to their evidence.",
    labels: ["concept"],
  },
  {
    id: "dec_pnpm_turbo",
    type: "decision",
    title: "pnpm workspaces with Turborepo and a single lockfile",
    summary: "The monorepo uses pnpm workspaces and Turborepo.",
    body: "The monorepo uses pnpm workspaces with a single lockfile and Turborepo for task orchestration. Internal dependencies use the workspace protocol.",
    labels: ["build"],
  },
  {
    id: "ins_embedding_degrade",
    type: "insight",
    title: "Embedding failure degrades to lexical search",
    summary: "A failed or unconfigured embedding never fails a search.",
    body: "When the embedding provider is unconfigured or unavailable, search degrades to full-text and graph ranking and reports the degraded mode, rather than returning an error.",
    labels: ["search", "reliability"],
  },

  // Distractor documents: plausible payments-platform engineering knowledge that
  // no query's `relevant` set names. They lower the top-10 fraction of the corpus
  // (30 relevant docs → 60) and compete for slots on RRF, so Recall@10 stops being
  // structurally inflated and a real ranking regression can move the metrics.
  {
    id: "dist_idempotent_charge",
    type: "pattern",
    title: "Client-supplied keys make charge submission idempotent",
    summary: "A retried charge with the same key returns the original result.",
    body: "Each charge submission carries a client-generated key; a resubmission with the same key returns the first outcome instead of double-charging the customer.",
    labels: ["payments", "reliability"],
  },
  {
    id: "dist_refund_flow",
    type: "concept",
    title: "Refund and reversal flow",
    summary: "A refund credits the customer; a reversal cancels an unsettled charge.",
    body: "A refund returns funds after settlement, while a reversal voids a charge that has authorized but not yet settled. The two follow different ledger entries.",
    labels: ["payments"],
  },
  {
    id: "dist_chargeback",
    type: "incident",
    title: "Chargeback dispute backlog",
    summary: "Disputes piled up when evidence submission was manual.",
    body: "A surge of chargeback disputes overwhelmed the manual evidence workflow; automating evidence packaging cleared the backlog within a settlement cycle.",
    labels: ["payments", "operations"],
  },
  {
    id: "dist_fraud_scoring",
    type: "concept",
    title: "Fraud risk scoring rules",
    summary: "A weighted rule set scores each charge before authorization.",
    body: "Incoming charges pass a weighted rule set that scores velocity, geography and device signals; a score above the block threshold declines the charge outright.",
    labels: ["payments", "risk"],
  },
  {
    id: "dist_settlement_recon",
    type: "pattern",
    title: "Settlement batch reconciliation",
    summary: "Daily settlement files are reconciled against internal records.",
    body: "Each daily settlement file from the acquiring bank is reconciled line by line against internal charge records, and any mismatch raises a break for manual review.",
    labels: ["payments", "finance"],
  },
  {
    id: "dist_minor_units",
    type: "decision",
    title: "Store monetary amounts in minor units",
    summary: "Amounts are integers of the currency minor unit, never floats.",
    body: "All monetary amounts are stored as integers in the currency minor unit, such as cents, so arithmetic never introduces floating-point rounding error.",
    labels: ["payments", "finance"],
  },
  {
    id: "dist_double_entry",
    type: "concept",
    title: "Double-entry ledger invariant",
    summary: "Every posting balances debits against credits.",
    body: "The ledger uses double-entry postings so that the sum of debits equals the sum of credits for every transaction, making the books provably balanced at all times.",
    labels: ["finance", "ledger"],
  },
  {
    id: "dist_card_vault",
    type: "decision",
    title: "Isolate stored card data in a dedicated vault",
    summary: "Raw card data lives only in an isolated vault service.",
    body: "Raw card data is confined to a dedicated vault service behind its own network boundary; the rest of the platform holds only opaque references to it.",
    labels: ["payments", "security"],
  },
  {
    id: "dist_step_up",
    type: "pattern",
    title: "Step-up verification for high-value charges",
    summary: "Charges above a threshold trigger an extra challenge.",
    body: "When a charge exceeds a configurable value threshold, the flow inserts an additional cardholder challenge before authorization proceeds.",
    labels: ["payments", "risk"],
  },
  {
    id: "dist_rate_limit",
    type: "pattern",
    title: "Token-bucket rate limiting on the public API",
    summary: "A token bucket caps request bursts per client.",
    body: "The public API meters each client with a token bucket that refills at a steady rate; a client that empties its bucket receives a 429 until it refills.",
    labels: ["api", "reliability"],
  },
  {
    id: "dist_webhook",
    type: "pattern",
    title: "Signed outbound webhook delivery",
    summary: "Outbound events are signed and delivered with backoff.",
    body: "Outbound webhook events carry a signature header so receivers can verify origin, and undelivered events back off on a growing schedule before dead-lettering.",
    labels: ["integration"],
  },
  {
    id: "dist_circuit_breaker",
    type: "pattern",
    title: "Circuit breaker around the acquiring bank",
    summary: "Repeated downstream failures trip a breaker open.",
    body: "Calls to the acquiring bank pass through a circuit breaker that opens after a burst of failures, shedding load and letting the downstream recover before probing again.",
    labels: ["reliability"],
  },
  {
    id: "dist_pool_sizing",
    type: "insight",
    title: "Ledger connection pool sizing",
    summary: "An oversized pool starved the ledger under load.",
    body: "An oversized database connection pool degraded the ledger under load because too many concurrent writers contended on the same rows; a smaller pool improved throughput.",
    labels: ["performance", "ledger"],
  },
  {
    id: "dist_read_replica",
    type: "decision",
    title: "Route reporting queries to a read replica",
    summary: "Heavy analytical reads go to a replica, not the primary.",
    body: "Reporting and analytical queries are routed to a read replica so that long scans never contend with the primary handling live charge writes.",
    labels: ["performance"],
  },
  {
    id: "dist_percentage_rollout",
    type: "decision",
    title: "Percentage rollout of risky changes",
    summary: "A new charge path is enabled for a growing traffic share.",
    body: "A risky change to the charge path is enabled for a small percentage of traffic first and widened only after its error rate stays within budget.",
    labels: ["release"],
  },
  {
    id: "dist_blue_green",
    type: "decision",
    title: "Blue-green release of the charge service",
    summary: "Two identical stacks swap on release with instant rollback.",
    body: "The charge service runs two identical stacks; a release shifts traffic to the idle stack and can roll back instantly by shifting it back, avoiding in-place upgrades.",
    labels: ["release"],
  },
  {
    id: "dist_tracing",
    type: "concept",
    title: "Distributed tracing across the charge path",
    summary: "A trace id follows a charge through every service.",
    body: "A single trace id propagates through every service a charge touches, so an operator can reconstruct the full path of one request across the platform.",
    labels: ["observability"],
  },
  {
    id: "dist_metric_cardinality",
    type: "insight",
    title: "Metric label cardinality budget",
    summary: "Unbounded labels blew up the metrics store.",
    body: "Attaching a high-cardinality label such as the raw charge id to a metric exploded the metrics store; labels are now restricted to a bounded set of dimensions.",
    labels: ["observability"],
  },
  {
    id: "dist_event_log_schema",
    type: "pattern",
    title: "Structured event log schema",
    summary: "Operational events share one typed envelope.",
    body: "Every operational event is emitted in one typed envelope with a fixed set of fields, so downstream consumers can parse events without bespoke handling per source.",
    labels: ["observability"],
  },
  {
    id: "dist_dead_letter",
    type: "pattern",
    title: "Dead-letter queue for failed events",
    summary: "Events that exhaust retries move to a dead-letter queue.",
    body: "An event that fails processing beyond its attempt limit is moved to a dead-letter queue for later inspection rather than blocking the main queue.",
    labels: ["integration", "reliability"],
  },
  {
    id: "dist_at_least_once",
    type: "concept",
    title: "At-least-once delivery semantics",
    summary: "Consumers must tolerate duplicate event delivery.",
    body: "The event bus guarantees at-least-once delivery, so every consumer is written to tolerate seeing the same event more than once without side effects.",
    labels: ["integration"],
  },
  {
    id: "dist_saga_payout",
    type: "pattern",
    title: "Saga for multi-step payouts",
    summary: "A payout runs as compensable steps, not one transaction.",
    body: "A multi-step payout runs as a saga of independently compensable steps, so a failure midway triggers compensating actions instead of a single rollback.",
    labels: ["payments", "workflow"],
  },
  {
    id: "dist_deadline_propagation",
    type: "insight",
    title: "Deadline propagation across services",
    summary: "A request deadline shrinks as it passes downstream.",
    body: "Each service subtracts its own elapsed time from the remaining request deadline before calling downstream, so a slow hop cannot make the whole chain exceed its budget.",
    labels: ["reliability"],
  },
  {
    id: "dist_graceful_degrade",
    type: "concept",
    title: "Graceful degradation under partial outage",
    summary: "Non-essential features shut off to protect the charge path.",
    body: "During a partial outage the platform disables non-essential features first, preserving the core charge path rather than failing the whole system at once.",
    labels: ["reliability"],
  },
  {
    id: "dist_payout_batching",
    type: "decision",
    title: "Schedule payouts in batches",
    summary: "Payouts accumulate and settle on a fixed schedule.",
    body: "Payouts accumulate through the day and settle in scheduled batches, cutting per-transfer cost and matching the downstream bank's batch windows.",
    labels: ["payments", "finance"],
  },
  {
    id: "dist_pci_scope",
    type: "concept",
    title: "PCI scope segmentation",
    summary: "Systems that touch card data are segmented to shrink scope.",
    body: "Only the narrow set of systems that handle card data sit inside the PCI boundary; network segmentation keeps everything else out of audit scope.",
    labels: ["security", "compliance"],
  },
  {
    id: "dist_encryption_rest",
    type: "decision",
    title: "Encrypt the ledger at rest",
    summary: "Ledger storage is encrypted with a managed key.",
    body: "The ledger's storage volume is encrypted at rest with a managed key, so a stolen disk yields no readable financial records.",
    labels: ["security", "ledger"],
  },
  {
    id: "dist_key_rotation",
    type: "pattern",
    title: "Rotate signing keys on a schedule",
    summary: "Signing keys overlap during a rotation window.",
    body: "Signing keys are rotated on a fixed schedule with an overlap window during which both the old and new key verify, so no in-flight signature is rejected.",
    labels: ["security"],
  },
  {
    id: "dist_load_shedding",
    type: "insight",
    title: "Load shedding under saturation",
    summary: "Low-priority work is dropped before the system tips over.",
    body: "When the system nears saturation it sheds low-priority work early, keeping latency bounded for charges rather than collapsing under uniform overload.",
    labels: ["performance", "reliability"],
  },
  {
    id: "dist_canary_analysis",
    type: "pattern",
    title: "Canary analysis before full rollout",
    summary: "A canary's metrics gate the wider release.",
    body: "A new build first serves a canary slice whose error and latency metrics are compared against the stable baseline; the wider rollout proceeds only if the canary stays healthy.",
    labels: ["release", "observability"],
  },
];

export const RELATIONS: FixtureRelation[] = [
  { from: "ins_retry_budget", to: "inc_payment_outage", type: "DERIVED_FROM" },
  { from: "rev_secret_redaction", to: "rul_no_secret_log", type: "RELATED_TO" },
  { from: "inc_ci_flake", to: "ins_windows_lock", type: "RELATED_TO" },
  { from: "dec_rrf", to: "dec_voyage", type: "RELATED_TO" },
  { from: "dec_repo_pattern", to: "dec_libsql", type: "RELATED_TO" },
  { from: "rul_payments_test", to: "inc_payment_outage", type: "APPLIES_TO" },
  { from: "dec_rrf", to: "con_authority", type: "RELATED_TO" },
  { from: "rev_path_safety", to: "pat_atomic_write", type: "RELATED_TO" },
];

export const QUERIES: FixtureQuery[] = [
  // --- Japanese natural language (20) ---
  {
    id: "q_ja_01",
    class: "ja-nl",
    text: "なぜリポジトリパターンを使うのか",
    relevant: ["dec_repo_pattern"],
  },
  {
    id: "q_ja_02",
    class: "ja-nl",
    text: "ローカルインデックスにlibSQLを使う理由",
    relevant: ["dec_libsql"],
  },
  {
    id: "q_ja_03",
    class: "ja-nl",
    text: "ハイブリッド検索のランキング方法",
    relevant: ["dec_rrf"],
  },
  { id: "q_ja_04", class: "ja-nl", text: "埋め込みモデルは何を使うのか", relevant: ["dec_voyage"] },
  {
    id: "q_ja_05",
    class: "ja-nl",
    text: "生成ファイルを編集してよいか",
    relevant: ["rul_gen_readonly"],
  },
  {
    id: "q_ja_06",
    class: "ja-nl",
    text: "決済サービスを変更するときの手順",
    relevant: ["rul_payments_test"],
  },
  {
    id: "q_ja_07",
    class: "ja-nl",
    text: "資格情報をログに出してよいか",
    relevant: ["rul_no_secret_log"],
  },
  { id: "q_ja_08", class: "ja-nl", text: "権威スコアの階層", relevant: ["con_authority"] },
  {
    id: "q_ja_09",
    class: "ja-nl",
    text: "リトライ予算はどれくらいにすべきか",
    relevant: ["ins_retry_budget"],
  },
  {
    id: "q_ja_10",
    class: "ja-nl",
    text: "Windowsでファイルロックが残る問題",
    relevant: ["ins_windows_lock"],
  },
  {
    id: "q_ja_11",
    class: "ja-nl",
    text: "決済ゲートウェイの障害",
    relevant: ["inc_payment_outage"],
  },
  {
    id: "q_ja_12",
    class: "ja-nl",
    text: "境界の入力検証にはどうするか",
    relevant: ["pat_zod_boundary"],
  },
  {
    id: "q_ja_13",
    class: "ja-nl",
    text: "シークレットのredaction時の注意",
    relevant: ["rev_secret_redaction"],
  },
  {
    id: "q_ja_14",
    class: "ja-nl",
    text: "シンボリックリンクとパス検証の安全性",
    relevant: ["rev_path_safety"],
  },
  {
    id: "q_ja_15",
    class: "ja-nl",
    text: "フックが内部で失敗したときの挙動",
    relevant: ["dec_hooks_failopen"],
  },
  {
    id: "q_ja_16",
    class: "ja-nl",
    text: "アドバイザリルールとガードレールの違い",
    relevant: ["con_guardrail_advisory"],
  },
  {
    id: "q_ja_17",
    class: "ja-nl",
    text: "日本語の全文検索の仕組み",
    relevant: ["ins_fts_trigram"],
  },
  {
    id: "q_ja_18",
    class: "ja-nl",
    text: "ダッシュボードの認証方式",
    relevant: ["dec_dashboard_auth"],
  },
  {
    id: "q_ja_19",
    class: "ja-nl",
    text: "正準ファイルの書き込みを壊さない方法",
    relevant: ["pat_atomic_write"],
  },
  {
    id: "q_ja_20",
    class: "ja-nl",
    text: "埋め込みが失敗したときの検索の挙動",
    relevant: ["ins_embedding_degrade"],
  },

  // --- English natural language (15) ---
  {
    id: "q_en_01",
    class: "en-nl",
    text: "why do we use the repository pattern",
    relevant: ["dec_repo_pattern"],
  },
  {
    id: "q_en_02",
    class: "en-nl",
    text: "reciprocal rank fusion for hybrid search",
    relevant: ["dec_rrf"],
  },
  {
    id: "q_en_03",
    class: "en-nl",
    text: "which embedding model and dimensions",
    relevant: ["dec_voyage"],
  },
  {
    id: "q_en_04",
    class: "en-nl",
    text: "can I edit generated files",
    relevant: ["rul_gen_readonly"],
  },
  {
    id: "q_en_05",
    class: "en-nl",
    text: "provenance first knowledge requirement",
    relevant: ["con_provenance"],
  },
  {
    id: "q_en_06",
    class: "en-nl",
    text: "retry budget versus job timeout",
    relevant: ["ins_retry_budget"],
  },
  {
    id: "q_en_07",
    class: "en-nl",
    text: "return Result instead of throwing exceptions",
    relevant: ["pat_result_type"],
  },
  {
    id: "q_en_08",
    class: "en-nl",
    text: "validate external input with zod",
    relevant: ["pat_zod_boundary"],
  },
  {
    id: "q_en_09",
    class: "en-nl",
    text: "turn and checkpoint lifecycle",
    relevant: ["dec_turn_checkpoint"],
  },
  {
    id: "q_en_10",
    class: "en-nl",
    text: "advisory rules versus guardrails",
    relevant: ["con_guardrail_advisory"],
  },
  {
    id: "q_en_11",
    class: "en-nl",
    text: "no background daemon in version 0.1",
    relevant: ["dec_no_daemon"],
  },
  {
    id: "q_en_12",
    class: "en-nl",
    text: "atomic rename for canonical writes",
    relevant: ["pat_atomic_write"],
  },
  {
    id: "q_en_13",
    class: "en-nl",
    text: "locale independent stderr parsing",
    relevant: ["rev_locale_stderr"],
  },
  {
    id: "q_en_14",
    class: "en-nl",
    text: "engineering memory graph overview",
    relevant: ["con_memory_graph"],
  },
  {
    id: "q_en_15",
    class: "en-nl",
    text: "embedding failure degrades to lexical",
    relevant: ["ins_embedding_degrade"],
  },

  // --- code / path / symbol (15) ---
  {
    id: "q_code_01",
    class: "code",
    text: "searchHybrid",
    relevant: ["dec_rrf"],
    scope: { symbols: ["searchHybrid"] },
  },
  {
    id: "q_code_02",
    class: "code",
    text: "upsertEntity",
    relevant: ["dec_repo_pattern"],
    scope: { symbols: ["upsertEntity"] },
  },
  {
    id: "q_code_03",
    class: "code",
    text: "charge",
    relevant: ["rul_payments_test", "inc_payment_outage"],
    scope: { symbols: ["charge"] },
  },
  {
    id: "q_code_04",
    class: "code",
    text: "src/generated",
    relevant: ["rul_gen_readonly"],
    scope: { paths: ["src/generated/index.ts"] },
    applicableRuleIds: ["rul_gen_readonly"],
  },
  {
    id: "q_code_05",
    class: "code",
    text: "src/payments service change",
    relevant: ["rul_payments_test"],
    scope: { paths: ["src/payments/service.ts"] },
    applicableRuleIds: ["rul_payments_test"],
  },
  {
    id: "q_code_06",
    class: "code",
    text: "packages/storage repository",
    relevant: ["dec_repo_pattern", "dec_libsql"],
    scope: { paths: ["packages/storage/src/index.ts"] },
  },
  {
    id: "q_code_07",
    class: "code",
    text: "packages/search hybrid ranking",
    relevant: ["dec_rrf"],
    scope: { paths: ["packages/search/src/search-hybrid.ts"] },
  },
  {
    id: "q_code_08",
    class: "code",
    text: "apps/dashboard authentication",
    relevant: ["dec_dashboard_auth"],
    scope: { paths: ["apps/dashboard/src/main.tsx"] },
  },
  { id: "q_code_09", class: "code", text: "tsdown ESM build", relevant: ["dec_esm"] },
  {
    id: "q_code_10",
    class: "code",
    text: "pnpm workspaces turborepo",
    relevant: ["dec_pnpm_turbo"],
  },
  {
    id: "q_code_11",
    class: "code",
    text: "trigram unicode61 tokenizer",
    relevant: ["ins_fts_trigram"],
  },
  {
    id: "q_code_12",
    class: "code",
    text: "WAL lock EBUSY windows",
    relevant: ["ins_windows_lock", "inc_ci_flake"],
  },
  {
    id: "q_code_13",
    class: "code",
    text: "fs.realpath symlink resolution",
    relevant: ["rev_path_safety"],
  },
  { id: "q_code_14", class: "code", text: "LC_ALL LANG stderr", relevant: ["rev_locale_stderr"] },
  {
    id: "q_code_15",
    class: "code",
    text: "Result safeParse boundary",
    relevant: ["pat_result_type", "pat_zod_boundary"],
  },

  // --- relationship / provenance (10) ---
  {
    id: "q_rel_01",
    class: "relationship",
    text: "what incident led to the retry budget insight",
    relevant: ["ins_retry_budget", "inc_payment_outage"],
  },
  {
    id: "q_rel_02",
    class: "relationship",
    text: "review learning related to the no-secret-logging rule",
    relevant: ["rev_secret_redaction", "rul_no_secret_log"],
  },
  {
    id: "q_rel_03",
    class: "relationship",
    text: "incident connected to the windows file lock insight",
    relevant: ["inc_ci_flake", "ins_windows_lock"],
  },
  {
    id: "q_rel_04",
    class: "relationship",
    text: "decisions related to hybrid search and embeddings",
    relevant: ["dec_rrf", "dec_voyage"],
  },
  {
    id: "q_rel_05",
    class: "relationship",
    text: "repository pattern and libSQL decisions",
    relevant: ["dec_repo_pattern", "dec_libsql"],
  },
  {
    id: "q_rel_06",
    class: "relationship",
    text: "which rule applies to the payment outage",
    relevant: ["rul_payments_test", "inc_payment_outage"],
  },
  {
    id: "q_rel_07",
    class: "relationship",
    text: "authority scoring used by hybrid ranking",
    relevant: ["dec_rrf", "con_authority"],
  },
  {
    id: "q_rel_08",
    class: "relationship",
    text: "atomic write pattern and path safety review",
    relevant: ["pat_atomic_write", "rev_path_safety"],
  },
  {
    id: "q_rel_09",
    class: "relationship",
    text: "provenance requirement and the memory graph",
    relevant: ["con_provenance", "con_memory_graph"],
  },
  {
    id: "q_rel_10",
    class: "relationship",
    text: "payments service rule and its incident evidence",
    relevant: ["rul_payments_test", "inc_payment_outage"],
    scope: { symbols: ["charge"] },
  },
];

/** The text embedded per document (matches `runEmbeddingSync`: title then body). */
export function docEmbeddingText(doc: FixtureDoc): string {
  return `${doc.title}\n\n${doc.body}`;
}
