/**
 * Shared `PrismaClient` for the `{{projectName}}` api (LEV-196).
 *
 * Both `auth.ts` (Better Auth's prisma adapter) and `index.ts` (the todo
 * CRUD handlers) import this one client so the api opens a single pg
 * connection pool per process instead of one per consumer. The pg driver
 * adapter is the Prisma 7 way to provide a connection string — see
 * `./auth.ts` for the longer explanation.
 *
 * Re-exports `prisma` as both a named export and the default so callers can
 * pick whichever import style fits.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? '',
  }),
});

export default prisma;
