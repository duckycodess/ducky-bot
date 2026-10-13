/**
 * Which addresses count as "not the public internet".
 *
 * The phone capture page is reachable over a TAILNET and nowhere else. That is
 * a claim about the network, and a claim like that has to be checked in code
 * or it is just a sentence in a document: an operator who types
 * `DUCKY_HTTP_HOST=0.0.0.0` to "make it work from my phone" would otherwise
 * publish the owner's records to whatever the host is attached to.
 *
 * The list is deliberately CLOSED and deliberately short:
 *
 * - loopback, for a single-machine run;
 * - RFC1918 (`10/8`, `172.16/12`, `192.168/16`), the ordinary private LAN;
 * - `100.64.0.0/10`, the CGNAT range Tailscale allocates IPv4 addresses from;
 * - `fd7a:115c:a1e0::/48`, the ULA prefix Tailscale allocates IPv6 from.
 *
 * `0.0.0.0` and `::` are refused explicitly: they are not addresses but "every
 * interface", which is precisely the thing that must not happen. There is no
 * entry for a public address and no way to add one through configuration, and
 * nothing here enables Tailscale Funnel -- Funnel is what would put this on
 * the internet, and nothing in this repository calls it.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const ipv4 = (host: string): number[] | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.some((o) => o > 255) ? undefined : octets;
};

export function isPrivateBindHost(raw: string): boolean {
  const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') return false;
  if (LOOPBACK.has(host)) return true;
  // "every interface" is never a private bind, whatever the host is attached to.
  if (host === '0.0.0.0' || host === '::' || host === '*') return false;

  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // Tailscale's own IPv6 prefix, and loopback. Nothing else: a global unicast
  // v6 address is exactly what this is here to refuse.
  if (host.startsWith('fd7a:115c:a1e0:')) return true;
  return false;
}
