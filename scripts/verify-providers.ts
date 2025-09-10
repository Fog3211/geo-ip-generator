/**
 * Verify IP geolocation accuracy across multiple providers.
 *
 * Notes:
 * - This script runs locally via `pnpm exec tsx scripts/verify-providers.ts`.
 * - It queries 6 providers without API keys to maximize coverage while avoiding auth.
 * - Providers: geojs.io, ip-api.com, ipwho.is, ipapi.co, db-ip.com (free key), freegeoip.app
 * - The script processes IPs sequentially to respect provider rate limits,
 *   while each IP fans out to providers in parallel with per-request timeouts.
 */

/* eslint-disable no-console */

type CountryCode = string; // 2-letter ISO 3166-1 alpha-2 (uppercase)

interface ProviderResult {
  provider: string;
  countryCode: CountryCode | null;
  responseMs: number;
  error: string | null;
}

interface IpVerification {
  ip: string;
  results: ProviderResult[];
  consensusCode: CountryCode | null;
  agreementRatio: number; // 0..1
}

const INPUT_IPS: string[] = [
  '134.238.59.49',
  '204.212.121.210',
  '104.192.95.16',
  '217.29.235.114',
  '15.230.177.190',
  '207.139.21.209',
  '5.23.22.247',
  '38.44.28.5',
  '2.17.36.70',
  '2.16.28.166',
  '160.119.95.158',
  '181.193.150.224',
  '13.34.58.248',
];

const REQUEST_TIMEOUT_MS = 6000;
const BETWEEN_IP_DELAY_MS = 1000; // keep under ip-api.com's rate limit

const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    promise
      .then((val) => {
        clearTimeout(id);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(id);
        reject(err);
      });
  });
};

const isIso2Country = (value: string): boolean => /^[A-Z]{2}$/.test(value);

const safeFetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { method: 'GET', headers: { 'accept': 'application/json' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
};

const measure = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const start = performance.now();
  const value = await fn();
  const end = performance.now();
  return { ms: Math.round(end - start), value };
};

const providers: Array<{
  name: string;
  lookup: (ip: string) => Promise<CountryCode | null>;
}> = [
  {
    name: 'geojs.io',
    lookup: async (ip: string): Promise<CountryCode | null> => {
      const obj = await safeFetchJson(`https://get.geojs.io/v1/ip/country/${encodeURIComponent(ip)}.json`);
      if (typeof obj === 'object' && obj !== null && 'country' in obj) {
        const code = (obj as { country?: unknown }).country;
        if (typeof code === 'string') {
          const cc = code.toUpperCase();
          return isIso2Country(cc) ? cc : null;
        }
      }
      return null;
    },
  },
  {
    name: 'ip-api.com',
    lookup: async (ip: string): Promise<CountryCode | null> => {
      const obj = await safeFetchJson(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,message`);
      if (typeof obj === 'object' && obj !== null) {
        const o = obj as { status?: unknown; countryCode?: unknown };
        if (o.status === 'success' && typeof o.countryCode === 'string') {
          const cc = o.countryCode.toUpperCase();
          return isIso2Country(cc) ? cc : null;
        }
      }
      return null;
    },
  },
  {
    name: 'ipwho.is',
    lookup: async (ip: string): Promise<CountryCode | null> => {
      const obj = await safeFetchJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`);
      if (typeof obj === 'object' && obj !== null) {
        const o = obj as { success?: unknown; country_code?: unknown };
        if (o.success === true && typeof o.country_code === 'string') {
          const cc = o.country_code.toUpperCase();
          return isIso2Country(cc) ? cc : null;
        }
      }
      return null;
    },
  },
  {
    name: 'ipapi.co',
    lookup: async (ip: string): Promise<CountryCode | null> => {
      const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, {
        method: 'GET',
        headers: { 'accept': 'text/plain' },
      });
      if (!res.ok) {
        return null;
      }
      const text = (await res.text()).trim().toUpperCase();
      return isIso2Country(text) ? text : null;
    },
  },
  {
    name: 'db-ip.com (free)',
    lookup: async (ip: string): Promise<CountryCode | null> => {
      const obj = await safeFetchJson(`https://api.db-ip.com/v2/free/${encodeURIComponent(ip)}`);
      if (typeof obj === 'object' && obj !== null && 'countryCode' in obj) {
        const code = (obj as { countryCode?: unknown }).countryCode;
        if (typeof code === 'string') {
          const cc = code.toUpperCase();
          return isIso2Country(cc) ? cc : null;
        }
      }
      return null;
    },
  },
  {
    name: 'freegeoip.app',
    lookup: async (ip: string): Promise<CountryCode | null> => {
      const obj = await safeFetchJson(`https://freegeoip.app/json/${encodeURIComponent(ip)}`);
      if (typeof obj === 'object' && obj !== null && 'country_code' in obj) {
        const code = (obj as { country_code?: unknown }).country_code;
        if (typeof code === 'string') {
          const cc = code.toUpperCase();
          return isIso2Country(cc) ? cc : null;
        }
      }
      return null;
    },
  },
];

const verifyIp = async (ip: string): Promise<IpVerification> => {
  const tasks = providers.map(async (p): Promise<ProviderResult> => {
    try {
      const { ms, value } = await measure(() => withTimeout(p.lookup(ip), REQUEST_TIMEOUT_MS));
      return { provider: p.name, countryCode: value, responseMs: ms, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'error';
      return { provider: p.name, countryCode: null, responseMs: 0, error: message };
    }
  });
  const results = await Promise.all(tasks);

  const codeCounts = new Map<string, number>();
  for (const r of results) {
    if (r.countryCode !== null) {
      codeCounts.set(r.countryCode, (codeCounts.get(r.countryCode) ?? 0) + 1);
    }
  }
  let consensus: CountryCode | null = null;
  let maxCount = 0;
  for (const [code, count] of codeCounts) {
    if (count > maxCount) {
      consensus = code;
      maxCount = count;
    }
  }
  const validCount = Array.from(codeCounts.values()).reduce((a, b) => a + b, 0);
  const agreementRatio = results.length > 0 ? maxCount / results.length : 0;

  return { ip, results, consensusCode: consensus, agreementRatio: Number(agreementRatio.toFixed(2)) };
};

const printTable = (verifications: IpVerification[]): void => {
  const header = ['IP', ...providers.map((p) => p.name), 'Consensus', 'Agree%'];
  const rows: string[][] = [];
  for (const v of verifications) {
    const row: string[] = [v.ip];
    for (const p of providers) {
      const r = v.results.find((x) => x.provider === p.name);
      if (r === undefined) {
        row.push('NA');
      } else {
        const cell = r.countryCode !== null ? `${r.countryCode} (${r.responseMs}ms)` : `ERR${r.error !== null ? `:${r.error}` : ''}`;
        row.push(cell);
      }
    }
    row.push(v.consensusCode ?? 'NA');
    row.push(`${Math.round(v.agreementRatio * 100)}%`);
    rows.push(row);
  }

  const colWidths = header.map((h, idx) => Math.max(h.length, ...rows.map((r) => r[idx]?.length ?? 0)));
  const fmt = (val: string, i: number): string => val.padEnd(colWidths[i], ' ');
  console.log(header.map(fmt).join(' | '));
  console.log(colWidths.map((w) => '-'.repeat(w)).join('-|-'));
  for (const r of rows) {
    console.log(r.map(fmt).join(' | '));
  }
};

const main = async (): Promise<void> => {
  const ips = INPUT_IPS;
  const out: IpVerification[] = [];
  for (let i = 0; i < ips.length; i += 1) {
    const ip = ips[i];
    console.log(`\nChecking ${ip} ...`);
    const v = await verifyIp(ip);
    out.push(v);
    if (i < ips.length - 1) {
      await sleep(BETWEEN_IP_DELAY_MS);
    }
  }
  console.log('\n');
  printTable(out);
  const overallAgree = out.length > 0 ? Math.round((out.reduce((acc, v) => acc + v.agreementRatio, 0) / out.length) * 100) : 0;
  console.log(`\nOverall average agreement: ${overallAgree}% over ${out.length} IPs, providers=${providers.length}.`);
};

void main();


