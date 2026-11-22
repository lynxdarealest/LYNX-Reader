import dns from 'node:dns/promises';
import net from 'node:net';

export const TWO_PART_TLDS = new Set([
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'com.vn',
  'net.vn',
  'org.vn',
  'edu.vn',
  'co.uk',
  'org.uk',
  'com.cn',
  'com.tw',
  'com.hk',
  'com.au',
]);

export function extractBaseDomain(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      // keep as-is
    }
  }
  host = host.replace(/^\[|\]$/g, '').replace(/^\.+/, '').split(':')[0];
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let val = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    val = ((val << 8) | n) >>> 0;
  }
  return val;
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToUint32(ip);
  if (n === null) return true;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255

  return false;
}

function parseIpv6Groups(rawIp: string): number[] | null {
  const noZone = rawIp.split('%')[0].toLowerCase();
  if (!noZone.includes(':')) return null;

  let working = noZone;
  // Convert trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two 16-bit groups
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToUint32(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dblIdx = working.indexOf('::');
  if (dblIdx !== -1 && working.indexOf('::', dblIdx + 2) !== -1) {
    return null; // Multiple '::' is invalid
  }

  let headParts: string[] = [];
  let tailParts: string[] = [];
  if (dblIdx !== -1) {
    const left = working.slice(0, dblIdx);
    const right = working.slice(dblIdx + 2);
    headParts = left ? left.split(':') : [];
    tailParts = right ? right.split(':') : [];
    if (headParts.length + tailParts.length >= 8) return null;
  } else {
    headParts = working.split(':');
    if (headParts.length !== 8) return null;
  }

  const zeroCount = 8 - headParts.length - tailParts.length;
  const fullParts = [
    ...headParts,
    ...Array(Math.max(0, zeroCount)).fill('0'),
    ...tailParts,
  ];
  if (fullParts.length !== 8) return null;

  const groups: number[] = [];
  for (const part of fullParts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

export function isBlockedIpv6(rawIp: string): boolean {
  const groups = parseIpv6Groups(rawIp);
  if (!groups) return true;

  const isFirstFiveZero =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0;

  // :: (unspecified) and ::1 (loopback)
  if (isFirstFiveZero && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
    return true;
  }

  // ::ffff:0:0/96 (IPv4-mapped IPv6) & ::/96 IPv4-compatible
  if (isFirstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const embeddedV4 = `${(groups[6] >>> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >>> 8) & 0xff}.${
      groups[7] & 0xff
    }`;
    if (isBlockedIpv4(embeddedV4)) return true;
  }

  // 64:ff9b::/96 (NAT64)
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return true;
  }

  // 64:ff9b:1::/48 (NAT64 local use)
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
    return true;
  }

  // 100::/64 (discard)
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) {
    return true;
  }

  // 2001:db8::/32 (documentation)
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
    return true;
  }

  // fc00::/7 (unique local IPv6)
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 (link-local) & fec0::/10 (site-local)
  if ((groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xffc0) === 0xfec0) {
    return true;
  }

  // ff00::/8 (multicast)
  if ((groups[0] & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const cleaned = rawIp.trim().replace(/^\[|\]$/g, '');
  const kind = net.isIP(cleaned);
  if (kind === 4) return isBlockedIpv4(cleaned);
  if (kind === 6) return isBlockedIpv6(cleaned);
  return true;
}

export function assertPublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('URL không hợp lệ. Vui lòng nhập đầy đủ http:// hoặc https://');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chỉ hỗ trợ giao thức HTTP và HTTPS.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Không hỗ trợ URL chứa thông tin đăng nhập trực tiếp (user:pass@).');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    throw new Error('URL thiếu tên máy chủ hợp lệ.');
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    throw new Error('Không được phép truy cập địa chỉ cục bộ hoặc mạng nội bộ.');
  }

  const ipKind = net.isIP(host);
  if (ipKind !== 0) {
    if (isBlockedIpAddress(host)) {
      throw new Error('Không được phép truy cập địa chỉ IP nội bộ, loopback hoặc link-local.');
    }
    return parsed;
  }

  // Block bare single-label internal hostnames without a dot (e.g. http://intranet/)
  if (!host.includes('.')) {
    throw new Error('Không được phép truy cập tên máy chủ nội bộ không có tên miền công khai.');
  }

  return parsed;
}

export async function assertPublicHttpUrlResolved(rawUrl: string): Promise<URL> {
  const parsed = assertPublicHttpUrl(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIP(host) !== 0) {
    return parsed;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(
      `Không thể phân giải tên miền "${host}". Vui lòng kiểm tra lại đường dẫn hoặc kết nối Internet.`
    );
  }

  if (!records || records.length === 0) {
    throw new Error(`Tên miền "${host}" không trả về địa chỉ mạng hợp lệ.`);
  }

  for (const rec of records) {
    if (isBlockedIpAddress(rec.address)) {
      throw new Error(
        `Tên miền "${host}" phân giải tới địa chỉ mạng nội bộ/riêng tư nên đã bị chặn để bảo vệ hệ thống.`
      );
    }
  }

  return parsed;
}

export function isCookieDomainAllowed(requestHost: string, cookieDomain: string): boolean {
  const reqHost = requestHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const cDom = cookieDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/^\[|\]$/g, '');
  if (!reqHost || !cDom) return false;

  if (net.isIP(reqHost) !== 0 || net.isIP(cDom) !== 0) {
    return reqHost === cDom;
  }

  // Reject bare TLDs / two-part public suffixes as overly broad cookie domains
  if (!cDom.includes('.') || TWO_PART_TLDS.has(cDom)) {
    return false;
  }

  return reqHost === cDom || reqHost.endsWith(`.${cDom}`);
}

export function isCookiePathMatch(pathname: string, cookiePath: string): boolean {
  const norm = cookiePath || '/';
  if (norm === '/') return true;
  if (pathname === norm) return true;
  const prefix = norm.endsWith('/') ? norm : `${norm}/`;
  return pathname.startsWith(prefix);
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
