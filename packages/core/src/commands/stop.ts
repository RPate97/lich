import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import { buildComposeBundle, writeComposeFile } from '../compose/stack';
import { makeComposeRunner, type ComposeRunner } from '../compose/runner';
import type { Registry } from '../registry';
import type { Command } from './types';
import type { DockerService, Service } from '../services/types';

export interface StopOptions {
  /** Service provider; defaults to getBuiltinServices. Tests can inject custom lists. */
  getServices?: () => Service[];
  /**
   * Factory for the compose runner. Defaults to {@link makeComposeRunner}.
   * Tests inject a stub that records the `down` call and never touches docker.
   */
  composeRunnerFactory?: (projectName: string, composeFile: string) => ComposeRunner;
}

function dockerServicesOnly(list: Service[]): DockerService[] {
  return list.filter((s): s is DockerService => s.kind === 'docker');
}

export function makeStopCommand(
  getRegistry: () => Registry,
  opts?: StopOptions,
): Command {
  const getServices = opts?.getServices ?? getBuiltinServices;
  const composeRunnerFactory = opts?.composeRunnerFactory ?? makeComposeRunner;

  return {
    name: 'stop',
    describe: 'Tear down the current worktree’s stack (volumes persist)',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const reg = getRegistry();

      return await reg.withLock(async () => {
        const entry = await reg.get(stackCtx.worktreeKey);
        if (!entry) {
          return { stopped: false, key: stackCtx.worktreeKey, reason: 'not running' };
        }

        // Re-emit the compose file with the recorded ports so `docker compose
        // down` finds the same project state it brought up. Compose only needs
        // the project name to match for container teardown, but we re-emit
        // defensively in case a stale file was edited or deleted.
        const docker = dockerServicesOnly(getServices());
        const bundle = buildComposeBundle(stackCtx, docker, entry.ports);
        await writeComposeFile(bundle);

        const runner = composeRunnerFactory(bundle.projectName, bundle.composeFilePath);
        await runner.down({ volumes: false });

        await reg.remove(stackCtx.worktreeKey);
        return { stopped: true, key: stackCtx.worktreeKey, containers: entry.containers };
      });
    },
  };
}
