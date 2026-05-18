/**
 * PortlessAdapter — pluggable interface for the public-URL forwarder slot.
 *
 * Hypothetical alternative implementations:
 *   - Portless    (current default; ships in `@levelzero/plugin-portless`)
 *   - ngrok       (`@ngrok/ngrok` SDK or `ngrok` CLI)
 *   - Cloudflare Tunnel (`cloudflared`)
 *   - Tailscale Funnel
 *   - localtunnel / serveo (lightweight alternatives)
 *   - LAN-only no-op (also shipped by `@levelzero/plugin-portless` as `noop`)
 *
 * Consumer-POV: callers want to "register a hostname → local target",
 * "remove it", "list what's currently forwarded", and "tell me if you're
 * available at all" (so commands can skip gracefully when no tunnel is
 * configured). They don't care which protocol (HTTP CONNECT, WireGuard,
 * QUIC, SSH reverse tunnel) the impl uses.
 *
 * NOTE: this `types.ts` lived in `@levelzero/plugin-portless` until LEV-174;
 * pulled back into core so that `commands/dev.ts` can take a typed
 * `PortlessAdapter` without import-ing the plugin package (which would
 * recreate the core → plugin dependency cycle this ticket killed).
 * `@levelzero/plugin-portless` re-exports the same names from here for
 * backwards-compatibility.
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
