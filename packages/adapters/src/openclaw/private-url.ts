import { DuckyError } from '@ducky/contracts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 100.64.0.0/10 -- the CGNAT range Tailscale allocates from. */
function isTailnetIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

export function isPrivateGatewayUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // `ws:`/`wss:` are accepted because that is what OpenClaw actually speaks:
  // the recorded surface is a WebSocket gateway (`ws://127.0.0.1:19001` on its
  // dev profile), not an HTTP JSON endpoint. `http(s):` stays accepted for a
  // health or dashboard URL on the same host.
  const ALLOWED = new Set(['http:', 'https:', 'ws:', 'wss:']);
  if (!ALLOWED.has(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (isTailnetIpv4(host)) return true;
  if (host.endsWith('.ts.net')) return true; // tailscale MagicDNS
  return false;
}

/**
 * The OpenClaw gateway must never be reachable from the public internet.
 * Enforced in code at construction and again at startup, so a misconfigured
 * URL fails loudly instead of quietly exposing the gateway.
 */
export function assertPrivateGatewayUrl(raw: string): void {
  if (!isPrivateGatewayUrl(raw)) {
    throw new DuckyError(
      'integration_not_verified',
      'The OpenClaw gateway URL must be loopback or a private tailnet address.',
    );
  }
}
