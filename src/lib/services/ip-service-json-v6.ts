/**
 * IPv6 JSON-based IP service
 * Loads IPv6 country-range dataset from remote/local JSON and generates random IPv6 addresses
 */

import { z } from 'zod';
import { cache as redisCache } from '~/lib/cache';

// Data model for IPv6 ranges
interface Ipv6Range {
  startIp: string;
  endIp: string;
  startIpBigInt: string; // decimal string to avoid precision loss in JSON
  endIpBigInt: string;   // decimal string to avoid precision loss in JSON
  isp?: string;
}

interface CountryDataV6 {
  id: string;  // ISO alpha-3
  code2: string; // ISO alpha-2
  nameEn: string;
  nameZh?: string;
  continent?: string;
  region?: string;
  ipv6Ranges: Ipv6Range[];
}

interface GeoIpv6Data {
  metadata: {
    version: string;
    generatedAt: string;
    countries: number;
    ipRanges: number;
    dataSize: string;
  };
  countries: CountryDataV6[];
}

const DATA_V6_CONFIG = {
  LOCAL_DATA_PATH:
    (process.env.GEO_DATA_V6_LOCAL_PATH && String(process.env.GEO_DATA_V6_LOCAL_PATH)) ||
    `${process.cwd()}/data/combined-geo-ipv6-data.json`,
  DATA_URL:
    (process.env.GEO_DATA_V6_URL && String(process.env.GEO_DATA_V6_URL)) ||
    'https://raw.githubusercontent.com/Fog3211/geo-ip-generator/main/data/combined-geo-ipv6-data.json',
  BACKUP_URL:
    (process.env.GEO_DATA_V6_BACKUP_URL && String(process.env.GEO_DATA_V6_BACKUP_URL)) ||
    'https://cdn.jsdelivr.net/gh/Fog3211/geo-ip-generator@main/data/combined-geo-ipv6-data.json',
  CACHE_TTL: 3600,
  CACHE_KEY: 'geo-ipv6-data',
} as const;

export const generateIpv6Schema = z.object({
  country: z.string().min(1).max(100),
  count: z.coerce.number().min(1).max(10).int().default(1),
});

// In-process short-lived cache to reduce fetch/parse overhead
let memoryCache: { data: GeoIpv6Data | null; timestamp: number; ttl: number } = {
  data: null,
  timestamp: 0,
  ttl: 300000, // 5 minutes
};

async function loadGeoIpv6Data(): Promise<GeoIpv6Data> {
  const now = Date.now();

  if (memoryCache.data && now - memoryCache.timestamp < memoryCache.ttl) {
    return memoryCache.data;
  }

  // Try Redis cache
  try {
    const cached = await redisCache.get<GeoIpv6Data>(DATA_V6_CONFIG.CACHE_KEY, 'latest');
    if (cached) {
      memoryCache = { data: cached, timestamp: now, ttl: memoryCache.ttl };
      return cached;
    }
  } catch (e) {
    console.warn('IPv6: failed to read Redis cache:', e);
  }

  // Dev local file
  if (process.env.NODE_ENV === 'development') {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(DATA_V6_CONFIG.LOCAL_DATA_PATH, 'utf-8');
      const parsed: GeoIpv6Data = JSON.parse(content);
      memoryCache = { data: parsed, timestamp: now, ttl: memoryCache.ttl };
      return parsed;
    } catch (e) {
      console.warn('IPv6: local file load failed, fallback to remote:', e);
    }
  }

  // Remote primary then backup
  let data: GeoIpv6Data;
  try {
    const res = await fetch(DATA_V6_CONFIG.DATA_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (primaryErr) {
    console.warn('IPv6: primary source failed, try backup:', primaryErr);
    const res2 = await fetch(DATA_V6_CONFIG.BACKUP_URL, { headers: { Accept: 'application/json' } });
    if (!res2.ok) throw new Error(`Backup HTTP ${res2.status}`);
    data = await res2.json();
  }

  if (!data.metadata || !Array.isArray(data.countries)) {
    throw new Error('IPv6: invalid data format');
  }

  try {
    await redisCache.set(DATA_V6_CONFIG.CACHE_KEY, 'latest', data, DATA_V6_CONFIG.CACHE_TTL);
    await redisCache.set('geo-ipv6-data', 'meta', {
      lastUpdated: data.metadata.generatedAt,
      version: data.metadata.version,
    }, DATA_V6_CONFIG.CACHE_TTL);
  } catch (e) {
    console.warn('IPv6: failed to write Redis cache:', e);
  }

  memoryCache = { data, timestamp: now, ttl: memoryCache.ttl };
  return data;
}

function ipv6ToBigInt(ip: string): bigint {
  // Normalize IPv6 using URL constructor trick is unreliable; implement parser
  // Split by '::' to handle compression
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const totalParts = headParts.length + tailParts.length;
  const missing = 8 - totalParts;
  const parts: string[] = [];
  parts.push(...headParts);
  for (let i = 0; i < Math.max(0, missing); i++) parts.push('0');
  parts.push(...tailParts);
  if (parts.length !== 8) throw new Error('Invalid IPv6 address');
  let value = 0n;
  for (const p of parts) {
    const v = BigInt(parseInt(p || '0', 16));
    value = (value << 16n) + v;
  }
  return value;
}

function bigIntToIpv6(x: bigint): string {
  const parts: string[] = new Array(8).fill('0');
  let tmp = x;
  for (let i = 7; i >= 0; i--) {
    const v = Number(tmp & 0xffffn);
    parts[i] = v.toString(16);
    tmp >>= 16n;
  }
  // Compress the longest zero run per RFC 5952
  let bestStart = -1; let bestLen = 0; let curStart = -1; let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (parts[i] === '0') {
      if (curStart === -1) { curStart = i; curLen = 1; } else { curLen++; }
    } else {
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      curStart = -1; curLen = 0;
    }
  }
  if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
  if (bestLen > 1) {
    const before = parts.slice(0, bestStart).join(':');
    const after = parts.slice(bestStart + bestLen).join(':');
    return `${before}${before ? ':' : ''}::${after ? ':' : ''}${after}`.replace(/^:|:$/g, '');
  }
  return parts.join(':');
}

// Uniform 128-bit random BigInt using Node crypto
import { randomBytes } from 'crypto';
const UINT128_MAX = (1n << 128n) - 1n;

function randomUint128(): bigint {
  const buf = randomBytes(16);
  let acc = 0n;
  for (const b of buf) acc = (acc << 8n) | BigInt(b);
  return acc;
}

function randomBigIntInRange(start: bigint, end: bigint): bigint {
  const range = end - start + 1n;
  const limit = UINT128_MAX - (UINT128_MAX % range);
  while (true) {
    const r = randomUint128();
    if (r <= limit) return start + (r % range);
  }
}

function weightedPickRange(ranges: Array<{ start: bigint; end: bigint; raw: Ipv6Range }>): Ipv6Range {
  // Guard: must have at least one range
  if (ranges.length === 0) {
    throw new Error('IPv6: no ranges available for weighted pick');
  }
  // Weight by count of addresses in each range
  const weights: bigint[] = ranges.map(r => (r.end - r.start + 1n));
  const total = weights.reduce((a, b) => a + b, 0n);
  let ticket = randomBigIntInRange(0n, total - 1n);
  for (let i = 0; i < ranges.length; i++) {
    const w = weights[i] ?? 0n;
    if (ticket < w) {
      const chosen = ranges[i];
      if (!chosen) break; // safety, will fallback below
      return chosen.raw;
    }
    ticket -= w;
  }
  // Fallback (should not happen): return last element which exists due to guard
  return ranges[ranges.length - 1]!.raw;
}

async function findCountryV6(query: string): Promise<CountryDataV6 | null> {
  const data = await loadGeoIpv6Data();
  const q = query.toLowerCase().trim();
  let c = data.countries.find(x => x.id.toLowerCase() === q || x.code2.toLowerCase() === q || x.nameEn.toLowerCase() === q || (x.nameZh?.toLowerCase() === q));
  if (!c) c = data.countries.find(x => x.nameEn.toLowerCase().includes(q) || (x.nameZh?.toLowerCase().includes(q)));
  return c ?? null;
}

export async function generateIpv6ByCountry(input: z.infer<typeof generateIpv6Schema>) {
  const { country, count } = input;
  const c = await findCountryV6(country);
  if (!c) throw new Error(`Country not found: ${country}`);
  if (!c.ipv6Ranges || c.ipv6Ranges.length === 0) throw new Error(`No IPv6 ranges for ${c.nameEn} (${c.code2})`);

  const generated: Array<{ ip: string; location: { region: string | null; city: string | null; isp: string | null }; ipRange: { startIp: string; endIp: string } } > = [];
  for (let i = 0; i < count; i++) {
    // Prepare weighted ranges lazily
    const weighted = c.ipv6Ranges.map(r => ({ start: BigInt(r.startIpBigInt), end: BigInt(r.endIpBigInt), raw: r }));
    const picked = weightedPickRange(weighted);
    const start = BigInt(picked.startIpBigInt);
    const end = BigInt(picked.endIpBigInt);
    const value = randomBigIntInRange(start, end);
    generated.push({
      ip: bigIntToIpv6(value),
      location: { region: null, city: null, isp: picked.isp ?? null },
      ipRange: { startIp: picked.startIp, endIp: picked.endIp },
    });
  }

  return {
    country: { id: c.id, code2: c.code2, nameEn: c.nameEn, nameZh: c.nameZh ?? undefined, continent: c.continent, region: c.region },
    ips: generated,
    totalRanges: c.ipv6Ranges.length,
    cached: false,
  };
}

export async function getCountriesV6() {
  const data = await loadGeoIpv6Data();
  return data.countries.map(c => ({ code: c.code2, code3: c.id, name: c.nameEn, nameZh: c.nameZh, ranges: c.ipv6Ranges.length }));
}


