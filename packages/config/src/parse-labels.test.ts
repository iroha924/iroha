import { describe, expect, it } from "vitest";
import { parseLabelsFile } from "./parse-labels.js";

function validYaml(): string {
  return `
schema_version: 1
labels:
  - id: architecture
    title: Architecture
    description: Architecture decisions and constraints
    color: "#5B5BD6"
  - id: security
    title: Security
    description: Security-relevant decisions
    color: "#D65B5B"
`;
}

describe("parseLabelsFile", () => {
  it("parses a valid, sorted labels.yaml", () => {
    const result = parseLabelsFile(validYaml());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.labels.map((l) => l.id)).toEqual(["architecture", "security"]);
    }
  });

  it("rejects a label id that violates the slug pattern", () => {
    const yaml = validYaml().replace("id: architecture", "id: Architecture_1");
    const result = parseLabelsFile(yaml);
    expect(result.ok).toBe(false);
  });

  it("rejects a color that is not a 6-digit hex code", () => {
    const yaml = validYaml().replace('"#5B5BD6"', '"blue"');
    const result = parseLabelsFile(yaml);
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate label id", () => {
    const yaml = validYaml().replace("id: security", "id: architecture");
    const result = parseLabelsFile(yaml);
    expect(result.ok).toBe(false);
  });

  it("rejects labels that are not sorted lexicographically by id", () => {
    const yaml = `
schema_version: 1
labels:
  - id: security
    title: Security
    description: Security-relevant decisions
    color: "#D65B5B"
  - id: architecture
    title: Architecture
    description: Architecture decisions and constraints
    color: "#5B5BD6"
`;
    const result = parseLabelsFile(yaml);
    expect(result.ok).toBe(false);
  });
});
