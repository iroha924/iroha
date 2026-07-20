import { FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { parseRepositoryConfig } from "./parse-repository-config.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const repositoryId = makeTypedId("repo", clock, random);

function validYaml(): string {
  return `
schema_version: 1
repository_id: ${repositoryId}
default_language: ja
canonical:
  require_human_approval: true
  session_auto_publish: false
search:
  embedding:
    enabled: false
    provider: voyage
    model: voyage-4-large
    dimension: 1024
    api_key_env: VOYAGE_API_KEY
forge:
  provider: github
  enabled: false
privacy:
  canonical_prompt_content: false
  canonical_transcript_content: false
`;
}

describe("parseRepositoryConfig", () => {
  it("parses a valid config.yaml", () => {
    const result = parseRepositoryConfig(validYaml());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repository_id).toBe(repositoryId);
      expect(result.value.default_language).toBe("ja");
      expect(result.value.search.embedding.provider).toBe("voyage");
    }
  });

  it("fails on malformed YAML", () => {
    const result = parseRepositoryConfig("canonical:\n  - broken: [1, 2\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects an unknown top-level key", () => {
    const result = parseRepositoryConfig(`${validYaml()}\nunknown_key: true\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects an embedding provider other than the v1-fixed 'voyage'", () => {
    const yaml = validYaml().replace("provider: voyage", "provider: openai");
    const result = parseRepositoryConfig(yaml);
    expect(result.ok).toBe(false);
  });

  it("rejects an api_key_env value that is not an environment variable name", () => {
    const yaml = validYaml().replace("VOYAGE_API_KEY", "sk-not-an-env-var-name");
    const result = parseRepositoryConfig(yaml);
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported default_language", () => {
    const yaml = validYaml().replace("default_language: ja", "default_language: fr");
    const result = parseRepositoryConfig(yaml);
    expect(result.ok).toBe(false);
  });
});
