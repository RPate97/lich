import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { LineCounter, parseDocument, type Document } from "yaml";

import { schema } from "./schema.js";
import type { LichConfig } from "./types.js";
import { suggestProperty } from "../util/levenshtein.js";
import { expandDiscover, DiscoverError } from "./discover.js";

export interface ParseError {
  message: string;
  /** Source path (file:line:col when available, else file). */
  location: string;
  kind: "yaml" | "schema" | "io";
}

export interface ParseSuccess {
  ok: true;
  config: LichConfig;
  sourcePath: string;
}

export interface ParseFailure {
  ok: false;
  errors: ParseError[];
  sourcePath: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    // `verbose: true` attaches `parentSchema` to ErrorObjects so the
    // "did you mean" hint in additionalPropertySuffix can read the
    // parent's `properties` map.
    const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

export async function parseConfig(filePath: string): Promise<ParseResult> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        ok: false,
        sourcePath: filePath,
        errors: [
          {
            kind: "io",
            message: `lich.yaml not found at ${filePath}`,
            location: filePath,
          },
        ],
      };
    }
    return {
      ok: false,
      sourcePath: filePath,
      errors: [
        {
          kind: "io",
          message: `failed to read ${filePath}: ${e.message ?? String(err)}`,
          location: filePath,
        },
      ],
    };
  }

  const lineCounter = new LineCounter();
  let doc: Document.Parsed;
  try {
    doc = parseDocument(source, { lineCounter });
  } catch (err) {
    // parseDocument rarely throws — most parse problems land in `doc.errors`.
    return {
      ok: false,
      sourcePath: filePath,
      errors: [
        {
          kind: "yaml",
          message: `failed to parse YAML: ${(err as Error).message ?? String(err)}`,
          location: filePath,
        },
      ],
    };
  }

  if (doc.errors.length > 0) {
    return {
      ok: false,
      sourcePath: filePath,
      errors: doc.errors.map((e) => {
        const start = e.pos?.[0];
        const location =
          typeof start === "number"
            ? formatLocation(filePath, lineCounter, start)
            : filePath;
        return {
          kind: "yaml" as const,
          message: e.message,
          location,
        };
      }),
    };
  }

  // Whitespace-only docs toJS to null — schema rejects via missing `version`.
  const value = doc.toJS();

  const validate = getValidator();
  const ok = validate(value);
  if (!ok) {
    const errors = (validate.errors ?? []).map((e) =>
      ajvErrorToParseError(e, filePath, doc, lineCounter)
    );
    return { ok: false, sourcePath: filePath, errors };
  }

  const config = value as unknown as LichConfig;

  // Expand `owned.<name>.discover:` blocks after AJV so the discover
  // module can assume the parent shape conforms.
  try {
    await expandDiscover(config, dirname(filePath));
  } catch (err) {
    if (err instanceof DiscoverError) {
      return {
        ok: false,
        sourcePath: filePath,
        errors: [
          {
            kind: "schema",
            message: `${err.location}: ${err.message}`,
            location: filePath,
          },
        ],
      };
    }
    throw err;
  }

  return {
    ok: true,
    sourcePath: filePath,
    config,
  };
}

function ajvErrorToParseError(
  e: ErrorObject,
  filePath: string,
  doc: Document.Parsed,
  lineCounter: LineCounter
): ParseError {
  const path = e.instancePath || "/";
  const ajvMsg = e.message ?? "is invalid";

  // For `additionalProperties` and `required` the offending key lives in
  // `params`, not `instancePath` — surface it.
  let message: string;
  if (e.keyword === "additionalProperties" && e.params?.additionalProperty) {
    const unknownKey = String(e.params.additionalProperty);
    const suffix = additionalPropertySuffix(unknownKey, e);
    message =
      `${path || "/"} has unknown property '${unknownKey}'` + suffix;
  } else if (e.keyword === "required" && e.params?.missingProperty) {
    message = `${path || "/"} ${ajvMsg} ('${e.params.missingProperty}')`;
  } else {
    message = `${path} ${ajvMsg}`.trim();
  }

  const location =
    locateInstancePath(path, doc, lineCounter, filePath) ?? filePath;

  return {
    kind: "schema",
    message,
    location,
  };
}

/**
 * "Did you mean" suffix for `additionalProperties` errors. Returns a
 * close-match hint when one exists, otherwise lists the valid keys.
 * Requires `verbose: true` on the Ajv compile.
 */
function additionalPropertySuffix(
  unknownKey: string,
  e: ErrorObject,
): string {
  const parentSchema = (e as ErrorObject & { parentSchema?: unknown })
    .parentSchema;
  if (!parentSchema || typeof parentSchema !== "object") return "";
  const props = (parentSchema as { properties?: Record<string, unknown> })
    .properties;
  if (!props || typeof props !== "object") return "";

  const allowed = Object.keys(props);
  if (allowed.length === 0) return "";

  const hint = suggestProperty(unknownKey, allowed);
  if (hint) return hint;

  return ` (valid: ${allowed.join(", ")})`;
}

function formatLocation(
  filePath: string,
  lineCounter: LineCounter,
  offset: number
): string {
  const pos = lineCounter.linePos(offset);
  if (!pos || pos.line === 0) return filePath;
  return `${filePath}:${pos.line}:${pos.col}`;
}

function locateInstancePath(
  instancePath: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
  filePath: string
): string | null {
  if (!instancePath || instancePath === "/") {
    return `${filePath}:1:1`;
  }

  // JSON Pointer: drop leading empty, unescape ~1 → / and ~0 → ~.
  const segments = instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

  try {
    const node = doc.getIn(segments, true) as
      | { range?: [number, number, number] | null }
      | undefined;

    const range = node?.range;
    if (!range) return null;
    return formatLocation(filePath, lineCounter, range[0]);
  } catch {
    return null;
  }
}
