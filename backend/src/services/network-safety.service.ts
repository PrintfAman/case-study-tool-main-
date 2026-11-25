import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export function validatePublicHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in URLs are not allowed');
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) throw new Error('Non-standard ports are not allowed');
  return url;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

function ipv6Value(address: string): bigint | null {
  let normalized = address.toLowerCase().split('%')[0];
  if (!normalized) return null;
  if (normalized.includes('.')) {
    const splitAt = normalized.lastIndexOf(':');
    const ipv4Part = normalized.slice(splitAt + 1);
    if (isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split('.').map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = `${normalized.slice(0, splitAt)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const sides = normalized.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = sides.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (sides.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return isPrivateIpv4(address);
  }
  if (isIP(address) !== 6) return true;
  const value = ipv6Value(address);
  if (value === null) return true;

  const ipv4MappedPrefix = BigInt('0xffff');
  if ((value >> 32n) === ipv4MappedPrefix) {
    const ipv4 = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.');
    return isPrivateIpv4(ipv4);
  }

  // Only global unicast (2000::/3) is accepted. This rejects loopback,
  // unspecified, link-local, unique-local, multicast, and reserved ranges.
  if ((value >> 125n) !== 1n) return true;
  const firstGroup = Number((value >> 112n) & 0xffffn);
  const secondGroup = Number((value >> 96n) & 0xffffn);
  if ((firstGroup === 0x2001 && secondGroup <= 0x01ff) || firstGroup === 0x2002) return true;
  return false;
}

export interface PublicUrlResolution {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** Resolves once and returns the checked socket address so callers can pin DNS. */
export async function resolvePublicUrl(input: string): Promise<PublicUrlResolution> {
  const url = validatePublicHttpUrl(input);
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Private and local network addresses are not allowed');
    return { url, address: hostname, family: isIP(hostname) as 4 | 6 };
  } else {
    const addressesPromise = lookup(hostname, { all: true });
    let dnsTimer: NodeJS.Timeout | undefined;
    let addresses: Awaited<typeof addressesPromise>;
    try {
      addresses = await Promise.race([
        addressesPromise,
        new Promise<never>((_resolve, reject) => {
          dnsTimer = setTimeout(() => reject(new Error('DNS lookup timed out')), 5_000);
          dnsTimer.unref();
        }),
      ]);
    } finally {
      if (dnsTimer) clearTimeout(dnsTimer);
    }
    if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
      throw new Error('URL resolves to a private or local network address');
    }
    const address = addresses[0];
    if (!address || (address.family !== 4 && address.family !== 6)) throw new Error('URL did not resolve to a supported public address');
    return { url, address: address.address, family: address.family };
  }
}

export async function assertPublicUrl(input: string): Promise<URL> {
  return (await resolvePublicUrl(input)).url;
}
