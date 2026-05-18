/**
 * PortlessAdapter — pluggable interface for the public-URL forwarder slot.
 *
 * As of LEV-174 the canonical type definitions live in
 * `@levelzero/core/adapters/portless/types`. This file re-exports them so
 * existing out-of-tree consumers that import from
 * `@levelzero/plugin-portless` keep working. New code should import from
 * core directly when possible.
 */
export type { PortlessAdapter, URLEntry } from '@levelzero/core/adapters/portless/types';
