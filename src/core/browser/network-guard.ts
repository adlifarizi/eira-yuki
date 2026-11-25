import dns from 'node:dns/promises';

/**
 * Checks whether a hostname or IP literal resolves to a private, loopback, or link-local address
 * to prevent Server-Side Request Forgery (SSRF).
 */
export function isPrivateIpOrHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower === '0.0.0.0' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '::'
  ) {
    return true;
  }

  // IPv6 ULA (fc00::/7 -> fc/fd) and link-local (fe80::/10)
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
    return true;
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (lower.startsWith('::ffff:')) {
    return isPrivateIpOrHost(lower.slice('::ffff:'.length));
  }

  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }

  return false;
}

/**
 * Resolves a hostname via DNS and verifies that none of its resolved IP addresses
 * belong to private, loopback, or link-local ranges (mitigating DNS rebinding).
 */
export async function isPrivateOrReservedHost(hostname: string): Promise<boolean> {
  if (isPrivateIpOrHost(hostname)) {
    return true;
  }

  try {
    const cleanHost = hostname.replace(/^\[|\]$/g, '');
    const records = await dns.lookup(cleanHost, { all: true });
    return records.some((record) => isPrivateIpOrHost(record.address));
  } catch {
    return false;
  }
}
