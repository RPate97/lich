import type { PrismaClient } from '@prisma/client';

/**
 * Sentinel error class used to trigger a Prisma transaction rollback while
 * preserving the callback's return value. We throw this from inside the
 * `$transaction` block once the body has run; Prisma sees the throw and rolls
 * back, and the outer `.catch` unwraps the value so the caller still gets it.
 *
 * Using a private class (rather than, say, a string sentinel) means user code
 * that throws an unrelated error of its own will still propagate naturally —
 * we only swallow our own marker.
 */
export class RollbackSignal<T> extends Error {
  readonly value: T;
  constructor(value: T) {
    super('RollbackSignal');
    this.name = 'RollbackSignal';
    this.value = value;
  }
}

/**
 * Run `fn` inside a Prisma transaction that always rolls back at the end.
 *
 * The callback receives the transaction client (typed as `PrismaClient` for
 * caller convenience — Prisma's interactive transaction client is a structural
 * subset and behaves identically for non-nested operations). All writes the
 * callback performs are visible *inside* the callback, but invisible once
 * `withRollback` returns: the transaction is aborted via an intentional throw
 * of `RollbackSignal`, which Prisma honors by issuing `ROLLBACK`.
 *
 * Any unrelated exception thrown by `fn` propagates out of `withRollback`
 * (it's not a `RollbackSignal`, so the outer catch rethrows). The transaction
 * still rolls back in that case via Prisma's normal error handling.
 *
 * Intended use: integration tests that need a clean DB per case without paying
 * the cost of `TRUNCATE`-ing every table between runs.
 */
export async function withRollback<T>(
  prisma: PrismaClient,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return prisma
    .$transaction(async (tx: PrismaClient) => {
      const result = await fn(tx as unknown as PrismaClient);
      throw new RollbackSignal(result);
    })
    .catch((err: unknown) => {
      if (err instanceof RollbackSignal) return err.value as T;
      throw err;
    });
}
