export interface UIContext {
  projectRoot: string;
  appDir: string;
}

export interface AddComponentOptions {
  dryRun?: boolean;
}

export interface AddComponentResult {
  command: string;
  cwd: string;
  executed: boolean;
  output: string;
}

export interface ListComponentsResult {
  installed: string[];
}

export interface UIAdapter {
  name: string;
  add(ctx: UIContext, component: string, opts?: AddComponentOptions): Promise<AddComponentResult>;
  list(ctx: UIContext): Promise<ListComponentsResult>;
}
