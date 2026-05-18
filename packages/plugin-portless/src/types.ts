/**
 * PortlessAdapter — pluggable interface for the public-URL forwarder slot.
 *
 * Hypothetical alternative implementations:
 *   - Portless  (current default; this package's `portless.ts`)
 *   - ngrok     (`@ngrok/ngrok` SDK or `ngrok` CLI)
 *   - Cloudflare Tunnel (`cloudflared`)
 *   - Tailscale Funnel
 *   - localtunnel / serveo (lightweight alternatives)
 *   - LAN-only no-op (already shipped here as `noop.ts`)
 *
 * Consumer-POV: callers want to "register a hostname → local target",
 * "remove it", "list what's currently forwarded", and "tell me if you're
 * available at all" (so commands can skip gracefully when no tunnel is
 * configured). They don't care which protocol (HTTP CONNECT, WireGuard,
 * QUIC, SSH reverse tunnel) the impl uses.
 *
 * NOTE: this `types.ts` lives in the plugin package (rather than in
 * `@levelzero/core/src/adapters/portless/types.ts`) because the portless
 * slot was extracted in LEV-145. Out-of-tree forwarder impls import these
 * types directly from `@levelzero/plugin-portless`. If we later add a
 * second concrete impl (e.g. `@levelzero/plugin-ngrok`), the type-only
 * exports should be pulled back into `@levelzero/core` so neither impl
 * has to peer-depend on the other.
 */

export interface URLEntry {
  host: string;
  target: string;
  service?: string;
}

export interface PortlessAdapter {
  name: string;
  available(): Promise<boolean>;
  register(input: { host: string; target: string }): Promise<void>;
  unregister(host: string): Promise<void>;
  list(): Promise<URLEntry[]>;
}
