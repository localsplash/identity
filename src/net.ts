import type express from 'express';

/**
 * IPv4/CIDR network trust (POC).
 *
 * Server-to-server endpoints are protected by an explicit IPv4 allowlist
 * instead of a shared application secret: TLS protects the transport, and
 * the configured CIDRs decide who may call. This authenticates a
 * server/network, not an individual application — applications sharing an
 * allowed egress IP can call the same endpoints. That is accepted for the
 * first-party POC on a controlled host and is NOT suitable for unrelated
 * or customer-hosted apps.
 *
 * Rules (deterministic by design):
 *   - Only IPv4 is trusted. Real IPv6 addresses are rejected outright.
 *   - The TCP socket peer is authoritative. A kernel-reported
 *     IPv4-mapped-IPv6 peer (::ffff:a.b.c.d) is normalised to its IPv4
 *     form since Node reports dual-stack sockets that way.
 *   - X-Forwarded-For is honoured ONLY when the direct peer is a private
 *     address, and then only across private hops: walking the chain
 *     right-to-left, the first hop that is not private is the client.
 *     Forwarded entries must be plain dotted-quad IPv4 — mapped/IPv6/
 *     malformed entries in the header are rejected, never coerced.
 *
 * There is no list of proxy addresses to configure. A reverse proxy in
 * front of this app reaches it over a private network by construction —
 * a container bridge, a LAN — while a caller arriving straight from the
 * internet presents a public peer and never has its header believed. That
 * covers the real deployments without asking a deployment to describe its
 * own plumbing, and it fails the safe way: the rule that decides whether
 * to read the header is the peer, which cannot be forged over TCP.
 *
 * The safety of the right-to-left walk rests on the proxy APPENDING the
 * peer it saw (nginx's $proxy_add_x_forwarded_for, Traefik, Caddy and the
 * cloud load balancers all do). A caller who prepends a private-looking
 * hop still has its own public address appended after it, so the walk
 * finds the public one and reports that. A caller already inside the
 * private network can spoof a hop — but it is inside the network the
 * policy trusts, so it has nothing left to gain.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Dotted-quad IPv4 → uint32, or null when not a well-formed IPv4 address. */
export function parseIpv4(raw: string): number | null {
  const m = IPV4_RE.exec(raw.trim());
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255 || (m[i].length > 1 && m[i].startsWith('0'))) return null;
    out = (out << 8) | octet;
  }
  return out >>> 0;
}

export interface Cidr {
  base: number;
  prefix: number;
}

/** "10.0.0.0/24" or a bare "10.0.0.5" (treated as /32) → Cidr, else null. */
export function parseCidr(raw: string): Cidr | null {
  const s = raw.trim();
  if (!s) return null;
  const slash = s.indexOf('/');
  const ipPart = slash === -1 ? s : s.slice(0, slash);
  const prefixPart = slash === -1 ? '32' : s.slice(slash + 1);
  const ip = parseIpv4(ipPart);
  if (ip === null) return null;
  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix < 0 || prefix > 32) return null;
  return { base: ip, prefix };
}

/**
 * Parse a comma-separated CIDR list. Throws on any malformed entry — a
 * silently dropped entry would fail open or closed unpredictably, and this
 * is security configuration.
 */
export function parseCidrList(raw: string): Cidr[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const cidr = parseCidr(entry);
      if (!cidr) throw new Error(`Invalid IPv4 CIDR entry: "${entry}"`);
      return cidr;
    });
}

export function ipInCidr(ip: number, cidr: Cidr): boolean {
  if (cidr.prefix === 0) return true;
  const mask = (0xffffffff << (32 - cidr.prefix)) >>> 0;
  return ((ip & mask) >>> 0) === ((cidr.base & mask) >>> 0);
}

export function ipInCidrs(ip: number, cidrs: Cidr[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

/**
 * The socket peer as IPv4. Node reports dual-stack IPv4 connections as
 * ::ffff:a.b.c.d; that kernel-provided form is unambiguous and normalised.
 * Anything else non-IPv4 (real IPv6, missing) yields null → rejected.
 */
export function socketPeerIpv4(remoteAddress: string | undefined): number | null {
  if (!remoteAddress) return null;
  const raw = remoteAddress.toLowerCase().startsWith('::ffff:')
    ? remoteAddress.slice(7)
    : remoteAddress;
  return parseIpv4(raw);
}

export interface ResolvedPeer {
  /** The IP access decisions are made against, dotted-quad. */
  ip: string;
  ipNum: number;
  /** True when the address came via a trusted proxy's forwarding header. */
  forwarded: boolean;
}

/**
 * The address ranges a reverse proxy sitting in front of this app occupies:
 * RFC1918, loopback, and link-local. Nothing routable from the internet is
 * in here, which is the whole point — see the note at the top of the file.
 */
const PRIVATE_CIDRS: Cidr[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
].map((entry) => parseCidr(entry)!);

/** True for RFC1918, loopback and link-local addresses. */
export function isPrivateIpv4(ip: number): boolean {
  return ipInCidrs(ip, PRIVATE_CIDRS);
}

/**
 * Resolve the client IP for a request. Defaults to the TCP socket peer;
 * X-Forwarded-For is evaluated only when that peer is private, and only
 * across private hops (right-to-left). Returns null when no deterministic
 * IPv4 client address exists — the caller must deny.
 */
export function resolveClientIp(
  req: Pick<express.Request, 'socket' | 'headers'>
): ResolvedPeer | null {
  const peer = socketPeerIpv4(req.socket?.remoteAddress ?? undefined);
  if (peer === null) return null;

  // A public peer is talking to us directly. Whatever it claims about who
  // it is forwarding for is its own assertion about itself, so ignore it.
  if (!isPrivateIpv4(peer)) {
    return { ip: formatIpv4(peer), ipNum: peer, forwarded: false };
  }

  const headerRaw = req.headers['x-forwarded-for'];
  const header = Array.isArray(headerRaw) ? headerRaw.join(',') : headerRaw;
  if (!header) {
    // Private peer, but nothing forwarded: the peer is the client. This is
    // the ordinary case for an app on the same network calling us directly.
    return { ip: formatIpv4(peer), ipNum: peer, forwarded: false };
  }

  // Walk right-to-left: skip private hops; the first public one is the
  // client. Forwarded entries must be strict IPv4 — a spoofable header
  // never gets the mapped-form leniency the socket does.
  const hops = header.split(',').map((s) => s.trim());
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIpv4(hops[i]);
    if (hop === null) return null; // malformed/IPv6/mapped entry → reject
    if (isPrivateIpv4(hop)) continue;
    return { ip: formatIpv4(hop), ipNum: hop, forwarded: true };
  }
  // Every hop was private — an internal caller that reached us through an
  // internal proxy. The leftmost is the one that started the chain.
  const leftmost = parseIpv4(hops[0]);
  if (leftmost === null) return null;
  return { ip: formatIpv4(leftmost), ipNum: leftmost, forwarded: true };
}

export function formatIpv4(ip: number): string {
  return [(ip >>> 24) & 255, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
}
