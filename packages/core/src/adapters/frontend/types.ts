/**
 * FrontendAdapter — pluggable interface for the typed-client slot.
 *
 * Hypothetical alternative implementations:
 *   - TypedClient  (current default; ships in `@levelzero/plugin-typed-client`)
 *   - OpenAPI      (codegen against an OpenAPI document; `openapi-typescript`)
 *   - tRPC         (passes through the backend's procedure router types)
 *   - GraphQL      (codegen against an introspected schema)
 *   - HeyAPI       (community `@hey-api/openapi-ts` generator)
 *
 * Consumer-POV: the contract takes a `RouteManifest` (slot-shaped, from the
 * active backend) plus an output directory, and writes generated files.
 * The caller does not care whether the impl emits Fetch wrappers, an
 * Axios-based client, GraphQL operations, or tRPC bindings — only the
 * fact that files were produced.
 *
 * The `RouteManifest` import below is the only cross-slot type reference
 * in this file. It is a CORE-owned shape (not a plugin-owned shape), so
 * importing it does not violate the cross-plugin-import rule — it is
 * just one slot consuming another slot's contract, exactly as
 * `docs/EXTENSION.md` "Composability rule" prescribes.
 */
import type { RouteManifest } from '../backend/types';

export interface GenerateClientInput {
  routes: RouteManifest;
  outDir: string;
}

export interface FrontendAdapter {
  name: string;
  generateClient(input: GenerateClientInput): Promise<{ files: string[] }>;
}
