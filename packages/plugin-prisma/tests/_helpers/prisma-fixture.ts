import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a minimal Prisma project directory tree in a tmpdir.
 *  Returns the absolute projectRoot. The schema has a `User` model and one
 *  empty `init` migration directory (so deploy is a no-op).
 *
 *  Prisma 7 (LEV-121): the datasource URL no longer lives on the schema's
 *  `datasource db { ... }` block — it's read from `prisma.config.ts` at
 *  config load time. The schema keeps `provider = "postgresql"`; the URL
 *  comes from `process.env.DATABASE_URL` via the config file. The adapter
 *  itself sets DATABASE_URL on every CLI invocation, so this fixture doesn't
 *  need a separate `.env` file.
 */
export function makePrismaFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lz-prisma-fixture-')));
  mkdirSync(join(root, 'prisma', 'migrations', '20260101000000_init'), { recursive: true });
  // Prisma 5+ rejects compact single-line generator/datasource blocks. Each
  // attribute must be on its own line.
  writeFileSync(join(root, 'prisma', 'schema.prisma'), `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  createdAt DateTime @default(now())
}
`.trim() + '\n');
  writeFileSync(join(root, 'prisma.config.ts'), `
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
`.trim() + '\n');
  writeFileSync(
    join(root, 'prisma', 'migrations', '20260101000000_init', 'migration.sql'),
    `CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`,
  );
  writeFileSync(join(root, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
  return root;
}
