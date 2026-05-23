/**
 * lich.yaml parser + validator.
 *
 * Reads a YAML file from disk, parses it with the `yaml` package's
 * `parseDocument` (so source line/col is preserved on each node), and
 * validates the parsed value against the Plan-1 JSON Schema using ajv.
 *
 * Returns a discriminated `ParseResult`:
 *   - `{ ok: true, config, sourcePath }`               on success
 *   - `{ ok: false, errors, sourcePath }`              on failure
 *
 * Each `ParseError` carries:
 *   - `message`  — human-readable, ready to print
 *   - `location` — `<file>:<line>:<col>` when we could map the offending
 *                  schema instancePath back to a YAML node, otherwise just
 *                  `<file>`
 *   - `kind`     — coarse category: `'io' | 'yaml' | 'schema'`
 *
 * Source-of-truth for shape: docs/superpowers/specs/2026-05-23-lich-v1-design.md
 * (section 4). The schema in `./schema.ts` is the executable spec.
 */

import { readFile } from "node:fs/promises";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { LineCounter, parseDocument, type Document } from "yaml";

import { schema } from "./schema.js";
import type { LichConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParseError {
  /** Human-readable message, ready to print. */
  message: string;
  /** Source path (file:line:col when available, else file). */
  location: string;
  /** Coarse kind: 'yaml' for parse-level failures, 'schema' for ajv failures, 'io' for file-read failures. */
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

// ---------------------------------------------------------------------------
// ajv — compiled once, reused
// ---------------------------------------------------------------------------

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function parseConfig(filePath: string): Promise<ParseResult> {
  // ---- read -------------------------------------------------------------
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

  // ---- yaml parse -------------------------------------------------------
  const lineCounter = new LineCounter();
  let doc: Document.Parsed;
  try {
    doc = parseDocument(source, { lineCounter });
  } catch (err) {
    // parseDocument itself rarely throws — most parse problems surface as
    // `doc.errors` below. But guard anyway in case of an unexpected throw.
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
        // yaml errors carry a `pos: [start, end]` and a formatted `message`.
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

  // ---- to JS ------------------------------------------------------------
  // toJS converts the document tree to a plain JS value suitable for ajv.
  // Empty documents (whitespace-only file) toJS to null — treat as a missing
  // root which the schema will reject for missing `version`.
  const value = doc.toJS();

  // ---- schema validate --------------------------------------------------
  const validate = getValidator();
  const ok = validate(value);
  if (!ok) {
    const errors = (validate.errors ?? []).map((e) =>
      ajvErrorToParseError(e, filePath, doc, lineCounter)
    );
    return { ok: false, sourcePath: filePath, errors };
  }

  // The schema's strictness guarantees the shape; cast through unknown so TS
  // doesn't worry about the structural lift from `any`.
  return {
    ok: true,
    sourcePath: filePath,
    config: value as unknown as LichConfig,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Turn an ajv error into a ParseError. The message follows the convention
 *   "<instancePath> <ajv.message>"
 * e.g. "/services/api/cmd must be string" — which Task 3 (lich validate) can
 * print directly. When we can map the instancePath back to a yaml node we
 * also append :line:col to the location.
 */
function ajvErrorToParseError(
  e: ErrorObject,
  filePath: string,
  doc: Document.Parsed,
  lineCounter: LineCounter
): ParseError {
  const path = e.instancePath || "/";
  const ajvMsg = e.message ?? "is invalid";

  // For "additionalProperties" and "required" the offending key isn't in
  // instancePath; ajv puts it in params. Surface it in the message so it's
  // actually useful.
  let message: string;
  if (e.keyword === "additionalProperties" && e.params?.additionalProperty) {
    message = `${path || "/"} has unknown property '${e.params.additionalProperty}'`;
  } else if (e.keyword === "required" && e.params?.missingProperty) {
    message = `${path || "/"} ${ajvMsg} ('${e.params.missingProperty}')`;
  } else {
    message = `${path} ${ajvMsg}`.trim();
  }

  // Try to resolve a source position by walking the parsed yaml document
  // along the instancePath. If that fails (path doesn't exist as a node, or
  // node has no range), fall back to filePath alone.
  const location =
    locateInstancePath(path, doc, lineCounter, filePath) ?? filePath;

  return {
    kind: "schema",
    message,
    location,
  };
}

/**
 * Convert an offset into a "file:line:col" string using the LineCounter.
 */
function formatLocation(
  filePath: string,
  lineCounter: LineCounter,
  offset: number
): string {
  const pos = lineCounter.linePos(offset);
  if (!pos || pos.line === 0) return filePath;
  return `${filePath}:${pos.line}:${pos.col}`;
}

/**
 * Walk a JSON-Pointer-style instancePath ("/services/api/cmd") through the
 * parsed yaml document and return a "file:line:col" if we found a node with
 * a range. Returns null on any miss — caller falls back to just the file.
 *
 * Best-effort only; ajv error mapping is a nice-to-have, not load-bearing.
 */
function locateInstancePath(
  instancePath: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
  filePath: string
): string | null {
  // Root error — point at the start of the file.
  if (!instancePath || instancePath === "/") {
    return `${filePath}:1:1`;
  }

  // JSON Pointer: split on "/", drop the leading empty, unescape ~1 -> /
  // and ~0 -> ~.
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
