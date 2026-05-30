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

  // Port-shape pre-checks: detect pre-LEV-525 names (`container`, `env`) and
  // bare `{ container_port: N }` block form. These produce friendlier errors
  // than AJV's generic `additionalProperties`/`oneOf` failures.
  const portErrors = validatePortShapes(value, doc, lineCounter, filePath);
  if (portErrors.length > 0) {
    return { ok: false, sourcePath: filePath, errors: portErrors };
  }

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

/**
 * Friendly errors for the LEV-525 port shape:
 *   - Old `{ container, env }` → suggest `{ container_port, published_env }`
 *   - Bare `{ container_port: N }` block (no `published_env`) → suggest scalar
 * AJV would also reject these but with generic `additionalProperties`/`oneOf`
 * failures that don't show the user the new shape.
 */
function validatePortShapes(
  value: unknown,
  doc: Document.Parsed,
  lineCounter: LineCounter,
  filePath: string,
): ParseError[] {
  const errors: ParseError[] = [];
  if (!value || typeof value !== "object") return errors;
  const root = value as Record<string, unknown>;

  const services = root.services;
  if (services && typeof services === "object" && !Array.isArray(services)) {
    for (const [svcName, svc] of Object.entries(services as Record<string, unknown>)) {
      if (!svc || typeof svc !== "object") continue;
      const ports = (svc as Record<string, unknown>).ports;
      walkPorts(ports, ["services", svcName, "ports"], errors, doc, lineCounter, filePath);
    }
  }

  const owned = root.owned;
  if (owned && typeof owned === "object" && !Array.isArray(owned)) {
    for (const [svcName, svc] of Object.entries(owned as Record<string, unknown>)) {
      if (!svc || typeof svc !== "object") continue;
      const port = (svc as Record<string, unknown>).port;
      checkDescriptor(port, ["owned", svcName, "port"], errors, doc, lineCounter, filePath);
      const ports = (svc as Record<string, unknown>).ports;
      walkPorts(ports, ["owned", svcName, "ports"], errors, doc, lineCounter, filePath);
    }
  }

  return errors;
}

function walkPorts(
  ports: unknown,
  pathSegments: string[],
  errors: ParseError[],
  doc: Document.Parsed,
  lineCounter: LineCounter,
  filePath: string,
): void {
  if (ports == null) return;
  if (Array.isArray(ports)) {
    for (let i = 0; i < ports.length; i++) {
      checkDescriptor(
        ports[i],
        [...pathSegments, String(i)],
        errors,
        doc,
        lineCounter,
        filePath,
      );
    }
  } else if (typeof ports === "object") {
    for (const [key, desc] of Object.entries(ports as Record<string, unknown>)) {
      checkDescriptor(
        desc,
        [...pathSegments, key],
        errors,
        doc,
        lineCounter,
        filePath,
      );
    }
  }
}

function checkDescriptor(
  desc: unknown,
  pathSegments: string[],
  errors: ParseError[],
  doc: Document.Parsed,
  lineCounter: LineCounter,
  filePath: string,
): void {
  if (desc == null || typeof desc !== "object" || Array.isArray(desc)) return;
  const d = desc as Record<string, unknown>;
  const path = "/" + pathSegments.join("/");
  const location = locateInstancePath(path, doc, lineCounter, filePath) ?? filePath;

  const hasOldContainer = Object.prototype.hasOwnProperty.call(d, "container");
  const hasOldEnv = Object.prototype.hasOwnProperty.call(d, "env");
  if (hasOldContainer || hasOldEnv) {
    const renames: string[] = [];
    if (hasOldContainer) renames.push("`container` → `container_port`");
    if (hasOldEnv) renames.push("`env` → `published_env`");
    errors.push({
      kind: "schema",
      location,
      message:
        `${path} uses the pre-LEV-525 port shape — rename ${renames.join(", ")}. ` +
        `New block form: \`{ container_port: <N>, published_env: <ENV_VAR> }\`. ` +
        `For ports with no env var, use the scalar shorthand: \`<N>\`.`,
    });
    return;
  }

  const hasContainerPort = Object.prototype.hasOwnProperty.call(d, "container_port");
  const hasPublishedEnv = Object.prototype.hasOwnProperty.call(d, "published_env");
  const hasHostPort = Object.prototype.hasOwnProperty.call(d, "host_port");
  if (hasContainerPort && !hasPublishedEnv && !hasHostPort) {
    errors.push({
      kind: "schema",
      location,
      message:
        `${path} is a bare \`{ container_port: <N> }\` block — use the scalar ` +
        `shorthand \`<N>\` instead. The block form is reserved for entries that ` +
        `also set \`published_env\` or \`host_port\`.`,
    });
  }
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
