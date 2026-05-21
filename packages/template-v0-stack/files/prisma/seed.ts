/**
 * Database seed for the `{{projectName}}` v0 template (LEV-196).
 *
 * Run via `levelzero db seed` (or `bun run prisma db seed` if you've ejected
 * from levelzero). The seed creates a stable demo user + a small set of todos
 * so a freshly-scaffolded project has tangible data the moment you open the
 * dashboard:
 *
 *   email:    demo@example.com
 *   password: demo1234
 *
 * These credentials are obviously fake — they exist for local exploration
 * only. Production deployments should rotate or delete the demo user before
 * going live. The seed is idempotent: re-running it does nothing if the
 * demo user already exists.
 *
 * Why we go through Better Auth's `signUpEmail` instead of writing the User
 * + Account rows directly with prisma: Better Auth hashes the password with
 * scrypt on the server side and writes it to the `Account` table — that's
 * what the sign-in form on `/sign-in` validates against. Replicating that
 * hash format with raw prisma writes is fragile (the kdf parameters live
 * inside the Better Auth package). Importing the configured auth instance
 * from `apps/api/src/auth.ts` keeps the seed in lockstep with however the
 * api has Better Auth wired.
 */
import { auth } from '../apps/api/src/auth';
import { prisma } from '../apps/api/src/prisma';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo1234';
const DEMO_NAME = 'Demo User';
const DEMO_TODOS = [
  { text: 'Read the LEVELZERO quickstart', done: true },
  { text: 'Open the dashboard and add a todo', done: false },
  { text: 'Wire `levelzero gen` into the web app', done: false },
];

async function ensureDemoUser(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    return existing.id;
  }
  // Better Auth's `signUpEmail` is the only public surface that writes the
  // scrypt-hashed password to the Account table in the shape `signInEmail`
  // later validates. We catch USER_ALREADY_EXISTS races defensively even
  // though the lookup above should make them rare.
  try {
    const result = await auth.api.signUpEmail({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
    });
    const user = (result as { user?: { id?: string } }).user;
    if (!user?.id) {
      throw new Error('seed: signUpEmail returned no user.id');
    }
    return user.id;
  } catch (err) {
    // Re-check in case another seeder (or a previous failed run) raced us.
    const recheck = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
    if (recheck) return recheck.id;
    throw err;
  }
}

async function main(): Promise<void> {
  const userId = await ensureDemoUser();

  // Skip the todo writes if any already exist for the demo user — keeps the
  // seed idempotent so `levelzero db seed` doesn't pile up duplicates.
  const existingCount = await prisma.todo.count({ where: { userId } });
  if (existingCount > 0) {
    console.log(`seed: demo user already has ${existingCount} todo(s); skipping`);
    return;
  }
  await prisma.todo.createMany({
    data: DEMO_TODOS.map((t) => ({ ...t, userId })),
  });
  console.log(`seed: created demo user ${DEMO_EMAIL} with ${DEMO_TODOS.length} todos`);
}

/**
 * "Table does not exist" is Prisma's P2021. This typically means the user
 * ran `levelzero db seed` before applying any migrations (a common state
 * for a freshly-scaffolded project with no `prisma/migrations` directory
 * yet). The seed is meant to be friendly — surface a helpful hint and
 * exit 0 so the levelzero dogfood path can move on to the next command.
 * Real "I tried to migrate and the seed still doesn't work" failures
 * surface as P1001 or similar codes and fall through to the hard error
 * branch below.
 */
function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'P2021' ||
    (typeof e.message === 'string' && /does not exist in the current database/i.test(e.message))
  );
}

main()
  .catch((err) => {
    if (isMissingTableError(err)) {
      console.log(
        'seed: skipping — the database schema is empty. Run `levelzero db migrate` ' +
          'after adding migration files (see https://www.prisma.io/docs/orm/prisma-migrate ' +
          'for the prisma migrate dev workflow).',
      );
      return;
    }
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
