import type { RouteManifest } from '../backend/types';

export interface GenerateClientInput {
  routes: RouteManifest;
  outDir: string;
}

export interface FrontendAdapter {
  name: string;
  generateClient(input: GenerateClientInput): Promise<{ files: string[] }>;
}
