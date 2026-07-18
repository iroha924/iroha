import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * `ajv`/`ajv-formats` are CommonJS packages whose default exports do not
 * resolve cleanly under `moduleResolution: "nodenext"` + `esModuleInterop`
 * (a confirmed upstream limitation: microsoft/TypeScript#52400). `require`
 * via `createRequire` sidesteps the broken ESM default-import interop while
 * keeping full static types through `typeof import(...)`.
 */
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js").Ajv2020;
const ajvFormatsModule: typeof import("ajv-formats") = require("ajv-formats");
const addFormats = ajvFormatsModule.default;

/** Compiles a Draft 2020-12 JSON Schema file (strict mode + formats) into a boolean validator. */
export function createAjvValidator(schemaPath: URL): (data: unknown) => boolean {
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
