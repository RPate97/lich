/**
 * PortlessAdapter — pluggable interface for the public-URL forwarder slot.
 *
 * As of LEV-174 the canonical type definitions live in
 * `@lich/core/adapters/portless/types`. This file re-exports them so
 * existing out-of-tree consumers that import from
 * `@lich/plugin-portless` keep working. New code should import from
 * core directly when possible.
 */
export type { PortlessAdapter, URLEntry } from '@lich/core/adapters/portless/types';
