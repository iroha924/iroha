import { Octokit } from "@octokit/core";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

/**
 * Octokit composed with the retry, throttling, and GraphQL-cursor-pagination
 * plugins. Transient failures (HTTP 429/5xx, primary/secondary rate limits) are
 * retried inside these plugins before any error surfaces to the provider.
 */
const ForgeOctokit = Octokit.plugin(retry, throttling, paginateGraphQL);

export type ForgeOctokit = InstanceType<typeof ForgeOctokit>;

export interface CreateOctokitOptions {
  /** GitHub token. Held only inside Octokit's auth layer — never logged or serialized. */
  token: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Retry + throttling resilience. Defaults to `true` (production). Tests set it
   * `false` so an error-path assertion returns immediately instead of waiting on
   * the retry/throttling backoff.
   */
  resilience?: boolean;
}

export function createOctokit(options: CreateOctokitOptions): ForgeOctokit {
  const resilience = options.resilience ?? true;
  return new ForgeOctokit({
    auth: options.token,
    ...(options.fetchImpl === undefined ? {} : { request: { fetch: options.fetchImpl } }),
    retry: { enabled: resilience },
    throttle: {
      enabled: resilience,
      // The plugin retries the request when we return true; cap at two retries.
      onRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < 2,
      onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < 2,
    },
  });
}
