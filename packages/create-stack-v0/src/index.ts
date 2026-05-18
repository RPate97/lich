/**
 * Programmatic entry point for `@levelzero/create-stack-v0`.
 *
 * The npx wrapper (`bin.ts`) is the primary user-facing surface, but the same
 * scaffolding capability is exposed here for callers that want to drive it
 * from code — fixtures, integration tests, downstream scaffolders, etc.
 *
 * This module deliberately keeps the surface area tiny: a single
 * `scaffoldStackV0` helper that delegates to `copyTemplate` from
 * `@levelzero/core` so behavior stays identical to `levelzero init <name>`.
 */
import { copyTemplate, type CopyTemplateOutput } from '@levelzero/core';
import { templateRoot as v0TemplateRoot } from '@levelzero/template-v0-stack';

export interface ScaffoldStackV0Input {
  /** Absolute path to the destination directory; created if missing. */
  to: string;
  /** Project name substituted into the template's `{{projectName}}` placeholders. */
  projectName: string;
  /**
   * Override the template source directory. Defaults to the bundled v0
   * template (`@levelzero/template-v0-stack`'s `templateRoot`). Override is
   * primarily useful for tests that want a smaller fake tree.
   */
  templateDir?: string;
}

/**
 * Materialize the bundled v0 stack template into `to`, substituting
 * `{{projectName}}` placeholders with the supplied name. Returns the list of
 * files written, with paths relative to `to`.
 */
export async function scaffoldStackV0(input: ScaffoldStackV0Input): Promise<CopyTemplateOutput> {
  const { to, projectName, templateDir } = input;
  return copyTemplate({
    from: templateDir ?? v0TemplateRoot,
    to,
    vars: { projectName },
  });
}

export { v0TemplateRoot as templateRoot };
