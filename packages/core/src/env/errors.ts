/**
 * Typed errors raised by the EnvSource resolution pipeline (Plan 16 / LEV-181).
 *
 * Each error extends the project-wide {@link CLIError} so the CLI dispatcher's
 * existing `code` + `hint` formatting picks them up unchanged. Subclasses
 * narrow the `code` literal and persist extra structured fields
 * (`sourceKey`, `consumerService`, `loadedNamespaces`, `plugins`, …) for
 * programmatic consumers — tests, the future `levelzero env` debug commands
 * (LEV-184), and anyone serialising errors through `toJSON()`.
 *
 * Boot- and resolution-time validation throws these synchronously so a
 * misconfigured project fails fast — before any compose service starts or
 * owned process is spawned.
 */

import { CLIError, type CLIErrorOptions } from '../errors';

/**
 * Raised when an `envInjection` entry references a source key that no loaded
 * plugin contributes. Message includes the consumer service, the missing
 * `sourceKey`, and the list of namespaces that ARE loaded so the author can
 * spot the typo (or the missing plugin) quickly.
 *
 * Triggered by either:
 *  - the boot-time static pass — named source key not registered AND its
 *    namespace has no bulk source either, so we can rule it out without
 *    awaiting any resolver
 *  - the per-service resolve pass — bulk namespace matched, but the runtime
 *    key wasn't in the bulk source's resolved keys
 */
export class EnvSourceMissingError extends CLIError {
  declare readonly code: 'ENV_SOURCE_MISSING';

  constructor(
    public readonly sourceKey: string,
    public readonly consumerService: string,
    public readonly loadedNamespaces: string[],
    options?: CLIErrorOptions,
  ) {
    super(
      'ENV_SOURCE_MISSING',
      `envInjection for service "${consumerService}" references "${sourceKey}" but no plugin contributes that source. Loaded namespaces: ${loadedNamespaces.length > 0 ? loadedNamespaces.join(', ') : '(none)'}`,
      options,
    );
    this.name = 'EnvSourceMissingError';
  }
}

/**
 * Raised when two distinct plugins claim the same namespace. The registry
 * already detects per-key (`namespace.name`) and per-bulk-namespace collisions
 * at registration time; this error is the higher-level "you have two plugins
 * trying to be `postgres`" version that the boot validation pass surfaces.
 *
 * `plugins` lists every plugin claiming the namespace, in registration order,
 * so the author can pick one and pass an explicit namespace to the other.
 */
export class NamespaceCollisionError extends CLIError {
  declare readonly code: 'NAMESPACE_COLLISION';

  constructor(
    public readonly namespace: string,
    public readonly plugins: string[],
    options?: CLIErrorOptions,
  ) {
    super(
      'NAMESPACE_COLLISION',
      `namespace "${namespace}" is claimed by multiple plugins: ${plugins.join(', ')}. Pass a unique namespace via the plugin's factory options.`,
      options,
    );
    this.name = 'NamespaceCollisionError';
  }
}

/**
 * Raised when a bulk source's `resolve()` throws. Wraps the underlying error
 * with the plugin's name + namespace so authors can attribute the failure
 * quickly. The original cause is preserved on `.cause` for debugging and
 * forwarded into `details` so `toJSON()` consumers see it too.
 */
export class BulkResolveError extends CLIError {
  declare readonly code: 'BULK_RESOLVE_FAILED';

  constructor(
    public readonly namespace: string,
    public readonly pluginName: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      'BULK_RESOLVE_FAILED',
      `bulk EnvSource for namespace "${namespace}" (plugin "${pluginName}") failed to resolve: ${reason}`,
      { details: { cause: reason } },
    );
    this.name = 'BulkResolveError';
    // Mirror the cause onto the standard Error field so `new Error(..., { cause })`
    // patterns (and Node's util.inspect) surface it consistently.
    (this as { cause?: unknown }).cause = cause;
  }
}
