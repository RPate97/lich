// Prisma 7 moved the datasource URL out of `schema.prisma` and into this
// config file (the `url = env("DATABASE_URL")` line on the schema's
// `datasource` block is deprecated). The schema still declares
// `provider = "postgresql"` so `prisma generate` / `prisma migrate`
// pick up the driver, but the connection string is read here at config
// load time.
//
// levelzero's plugin-postgres publishes DATABASE_URL through envInjection
// (declared in `levelzero.config.ts`), so by the time prisma loads this
// file the variable is already present in `process.env`. We pull it in
// via `dotenv/config` for the case where prisma CLI is invoked directly
// (outside `levelzero run`) and the project's `.env` is the source of
// truth.
import 'dotenv/config';
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
