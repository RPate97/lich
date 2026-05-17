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
