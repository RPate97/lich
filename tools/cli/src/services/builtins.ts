import type { Service } from './types';
import { pgService } from './postgres';

export function getBuiltinServices(): Service[] {
  return [pgService];
}
