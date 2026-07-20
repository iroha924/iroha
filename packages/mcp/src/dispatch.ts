import { IrohaError } from "@iroha/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { failureEnvelope, type McpEnvelope, newTraceId, successEnvelope } from "./envelope.js";
import { TOOLS } from "./tools/index.js";
import type { McpToolContext } from "./tools/types.js";

/** mcp-contract.md §8: requests larger than 256 KiB are rejected. */
const MAX_REQUEST_BYTES = 256 * 1024;

function toToolResult<T>(envelope: McpEnvelope<T>): CallToolResult {
  const text = envelope.ok ? "ok" : `error ${envelope.error.code}: ${envelope.error.message}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: envelope as unknown as { [key: string]: unknown },
    isError: !envelope.ok,
  };
}

/**
 * Compact, value-free description of which fields failed strict validation:
 * field names and offending unknown keys only — never a received value, so no
 * secret or path can leak through an input error.
 */
function describeInputIssues(error: z.ZodError): string {
  const labels = error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys;
    }
    const path = issue.path.join(".");
    return [path.length > 0 ? path : "(root)"];
  });
  const unique = [...new Set(labels)];
  return unique.length > 0 ? `Invalid input: ${unique.join(", ")}` : "Invalid input";
}

/**
 * Routes a `tools/call` to the matching tool: enforces the request-size limit,
 * strict-validates the input (unknown fields rejected → `INVALID_INPUT`), runs
 * the handler, and wraps the result in the §4 envelope. Every outcome — unknown
 * tool, oversize, invalid input, domain error, or an unexpected throw — becomes
 * a typed envelope; a raw stack never reaches the model.
 */
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: McpToolContext,
): Promise<CallToolResult> {
  const traceId = newTraceId(ctx.random);

  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return toToolResult(
      failureEnvelope(new IrohaError("NOT_FOUND", `Unknown tool: ${name}`), traceId),
    );
  }

  const args = rawArgs ?? {};
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_REQUEST_BYTES) {
    return toToolResult(
      failureEnvelope(
        new IrohaError("LIMIT_EXCEEDED", "Request exceeds the 256 KiB limit"),
        traceId,
      ),
    );
  }

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return toToolResult(
      failureEnvelope(new IrohaError("INVALID_INPUT", describeInputIssues(parsed.error)), traceId),
    );
  }

  try {
    const result = await tool.handler(parsed.data, ctx);
    return toToolResult(
      result.ok ? successEnvelope(result.value, traceId) : failureEnvelope(result.error, traceId),
    );
  } catch (cause) {
    // Transport boundary: a use-case that throws instead of returning `err`
    // must still yield a typed envelope, never a raw stack to the model.
    return toToolResult(
      failureEnvelope(new IrohaError("INTERNAL_ERROR", "Internal error", { cause }), traceId),
    );
  }
}
