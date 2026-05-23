/**
 * UIAdapter — pluggable interface for the UI components slot.
 *
 * Hypothetical alternative implementations:
 *   - shadcn/ui    (current default; ships in `@lich/plugin-shadcn`)
 *   - Tremor       (chart-focused React components)
 *   - Park UI      (Ark UI + Panda CSS recipes)
 *   - Mantine      (component library via CLI installer)
 *   - HeadlessUI   (Tailwind Labs primitives)
 *   - Radix Themes (Radix UI's themed wrapper)
 *
 * Consumer-POV: callers want to "add component X to my app" and "list what
 * components are already installed". The contract is intentionally string-
 * keyed (`component: 'button'`) because each impl owns its own registry of
 * component names — the consumer doesn't need to know whether the impl
 * shells out to a CLI, copies files from a template, or fetches from a
 * remote registry.
 *
 * Any impl in this slot MUST handle its own discovery + materialization
 * inside `add()` — the contract only exposes a stable name and a stable
 * "did this happen" signal. Library-specific knobs (theme tokens,
 * css-variables base, monorepo aliases) stay inside the impl and its
 * own per-plugin config schema.
 */

export interface UIContext {
  projectRoot: string;
  /** Path (relative to `projectRoot`) of the frontend app that will receive components. */
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
