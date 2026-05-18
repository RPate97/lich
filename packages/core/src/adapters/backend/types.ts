/**
 * BackendAdapter — pluggable interface for the HTTP backend slot.
 *
 * Hypothetical alternative implementations:
 *   - Hono     (current default; ships in `@levelzero/plugin-hono`)
 *   - Express  (long-standing Node HTTP framework)
 *   - Elysia   (Bun-native framework)
 *   - Fastify  (schema-first; JSON-schema route declarations)
 *   - Koa      (middleware-centric)
 *   - tRPC     (procedure-router; would surface routes via its router introspection)
 *
 * Consumer-POV: the only thing OTHER slots ask of the backend is "give me a
 * description of the routes you expose" — so they can generate a typed
 * client (frontend slot), drive e2e fixtures (test-runner slot), or wire
 * up port forwards (portless slot). That's why the interface is just
 * `extractRoutes(projectRoot) -> RouteManifest`.
 *
 * The impl is free to derive the manifest however it wants — AST scan of
 * the app source, runtime introspection of `app.routes`, reading an
 * OpenAPI doc, etc.
 *
 * NOTE: `RouteEntry.method` is the HTTP-verb set, which presumes an HTTP
 * backend. RPC-style backends (gRPC, JSON-RPC) would need a different
 * manifest shape — but the frontend slot ALSO assumes HTTP today, so the
 * pair moves together. If/when we add a non-HTTP backend, both
 * `RouteManifest` and `FrontendAdapter` should generalize at once.
 */

export interface RouteEntry {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  path: string;             // e.g. '/api/users/:id'
  handlerName?: string;     // optional source-level handler symbol
}

export interface RouteManifest {
  generatedAt: string;      // ISO8601
  routes: RouteEntry[];
}

export interface BackendAdapter {
  name: string;
  extractRoutes(projectRoot: string): Promise<RouteManifest>;
}
