/**
 * @iroha/forge-github — GitHub implementation of the `ForgeProvider` port. Uses
 * the octokit GraphQL stack (retry + throttling + cursor pagination) with typed,
 * codegen'd operations, validates every response with Zod, and degrades all
 * failures to `FORGE_UNAVAILABLE` without ever serializing the token.
 */

export type { CreateGitHubProviderOptions } from "./github-provider.js";
export { createGitHubProvider } from "./github-provider.js";
