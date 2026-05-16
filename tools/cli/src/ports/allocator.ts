import { isPortFree as defaultIsFree } from './free-port';

export const PORT_RANGE_START = 54000;
export const PORT_RANGE_END = 54999;

export type PortMap = Record<string, number>;

export interface AllocateOptions {
  isFree?: (port: number) => Promise<boolean>;
  reservedPorts?: Set<number>;
}

export async function allocatePorts(
  names: string[],
  opts: AllocateOptions = {},
): Promise<PortMap> {
  const isFree = opts.isFree ?? defaultIsFree;
  const reserved = opts.reservedPorts ?? new Set<number>();
  const result: PortMap = {};

  let cursor = PORT_RANGE_START;
  for (const name of names) {
    let found: number | null = null;
    while (cursor <= PORT_RANGE_END) {
      const candidate = cursor++;
      if (reserved.has(candidate)) continue;
      if (await isFree(candidate)) {
        found = candidate;
        reserved.add(candidate);
        break;
      }
    }
    if (found === null) {
      throw new Error(
        `no free ports remain in levelzero range ${PORT_RANGE_START}-${PORT_RANGE_END}`,
      );
    }
    result[name] = found;
  }
  return result;
}
