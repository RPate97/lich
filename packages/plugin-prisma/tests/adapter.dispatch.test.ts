import { describe, it, expect } from 'vitest';
import { prismaAdapter } from '../src/adapter';

// Unit tests for `prismaAdapter.resetDatabase`'s driver dispatch (LEV-172).
// These don't touch a real database — they just verify the dispatch branch
// throws actionable errors for non-postgres drivers, which is what protects
// callers from silently no-op'ing on an unsupported datasource.
describe('prismaAdapter.resetDatabase (dispatch)', () => {
  it('throws an actionable error for an unsupported driver', async () => {
    await expect(
      prismaAdapter.resetDatabase({
        databaseUrl: 'redis://localhost:6379',
        projectRoot: '/tmp/does-not-matter',
      }),
    ).rejects.toThrow(/unsupported driver "redis"/);
  });

  it('throws an actionable error for an unparseable URL', async () => {
    await expect(
      prismaAdapter.resetDatabase({
        databaseUrl: 'not-a-url',
        projectRoot: '/tmp/does-not-matter',
      }),
    ).rejects.toThrow(/unsupported driver "unknown"/);
  });

  it('mentions the helper file in the error so contributors know where to add support', async () => {
    await expect(
      prismaAdapter.resetDatabase({
        databaseUrl: 'mysql://localhost:3306/db',
        projectRoot: '/tmp/does-not-matter',
      }),
    ).rejects.toThrow(/packages\/plugin-prisma\/src\/adapter\.ts/);
  });
});
