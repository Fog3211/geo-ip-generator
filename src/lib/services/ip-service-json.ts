/**
 * 基于JSON数据的IP服务 - 无数据库版本
 * 从GitHub托管的JSON文件读取数据，提供快速IP查询服务
 */

import { z } from 'zod';

// 简化的缓存接口，用于JSON服务
interface SimpleCache {
  get<T>(key: string, identifier: string): Promise<T | null>;
  set(key: string, identifier: string, data: unknown, ttl: number): Promise<void>;
}

// 创建一个简单的内存缓存实现
class MemoryCache implements SimpleCache {
  private cache = new Map<string, { data: unknown; expires: number }>();

  async get<T>(prefix: string, identifier: string): Promise<T | null> {
    const key = `${prefix}:${identifier}`;
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data as T;
  }

  async set(prefix: string, identifier: string, data: unknown, ttl: number): Promise<void> {
    const key = `${prefix}:${identifier}`;
    const expires = Date.now() + (ttl * 1000);
    this.cache.set(key, { data, expires });
  }
}

// 使用内存缓存作为备用
const cache: SimpleCache = new MemoryCache();

// 数据类型定义
interface IpRange {
  startIp: string;
  endIp: string;
  startIpInt: string;
  endIpInt: string;
  isp?: string;
}

interface CountryData {
  id: string;
  code2: string;
  nameEn: string;
  nameZh?: string;
  continent?: string;
  region?: string;
  independent: boolean;
  unMember: boolean;
  ipRanges: IpRange[];
}

interface GeoIpData {
  metadata: {
    version: string;
    generatedAt: string;
    countries: number;
    ipRanges: number;
    dataSize: string;
  };
  countries: CountryData[];
}

// 配置
const DATA_CONFIG = {
  // 本地测试路径（可通过环境变量覆盖）
  LOCAL_DATA_PATH:
    (process.env.GEO_DATA_LOCAL_PATH && String(process.env.GEO_DATA_LOCAL_PATH)) ||
    `${process.cwd()}/data/combined-geo-ip-data.json`,
  // 远端主数据源（可通过环境变量覆盖）
  DATA_URL:
    (process.env.GEO_DATA_URL && String(process.env.GEO_DATA_URL)) ||
    'https://raw.githubusercontent.com/Fog3211/geo-ip-generator/main/data/combined-geo-ip-data.json',
  // 备用CDN URL（可通过环境变量覆盖）
  BACKUP_URL:
    (process.env.GEO_DATA_BACKUP_URL && String(process.env.GEO_DATA_BACKUP_URL)) ||
    'https://cdn.jsdelivr.net/gh/Fog3211/geo-ip-generator@main/data/combined-geo-ip-data.json',
  // 缓存TTL (1小时)
  CACHE_TTL: 3600,
  // 数据缓存key
  CACHE_KEY: 'geo-ip-data',
} as const;

// 输入验证
export const generateIpSchema = z.object({
  country: z.string()
    .min(1, 'Country parameter is required')
    .max(100, 'Country parameter too long'),
  count: z.coerce.number()
    .min(1, 'Count must be at least 1')
    .max(10, 'Count cannot exceed 10')
    .int('Count must be an integer')
    .default(1),
});

// 内存缓存，避免重复网络请求
let memoryCache: {
  data: GeoIpData | null;
  timestamp: number;
  ttl: number;
} = {
  data: null,
  timestamp: 0,
  ttl: 300000, // 5分钟内存缓存
};

/**
 * 从远程URL或本地文件加载地理IP数据
 */
async function loadGeoIpData(): Promise<GeoIpData> {
  const now = Date.now();
  
  // 检查内存缓存
  if (memoryCache.data && (now - memoryCache.timestamp) < memoryCache.ttl) {
    return memoryCache.data;
  }

  // 尝试从本地文件加载（开发环境）
  if (process.env.NODE_ENV === 'development') {
    try {
      const fs = await import('fs/promises');
      console.log('🔄 Loading geo IP data from local file...');
      const fileContent = await fs.readFile(DATA_CONFIG.LOCAL_DATA_PATH, 'utf-8');
      const data: GeoIpData = JSON.parse(fileContent);
      
      console.log(`✅ Loaded local geo IP data: ${data.metadata.countries} countries, ${data.metadata.ipRanges} IP ranges`);
      
      // 更新内存缓存
      memoryCache.data = data;
      memoryCache.timestamp = now;
      
      return data;
    } catch (localError) {
      console.warn('Failed to load local data, trying remote sources:', localError);
    }
  }

  // 尝试从Redis缓存获取
  try {
    const cached = await cache.get<GeoIpData>(DATA_CONFIG.CACHE_KEY, 'latest');
    if (cached) {
      memoryCache.data = cached;
      memoryCache.timestamp = now;
      return cached;
    }
  } catch (error) {
    console.warn('Failed to get data from cache:', error);
  }

  // 从远程URL获取数据
  console.log('🌍 Loading geo IP data from remote source...');
  
  let data: GeoIpData;
  
  try {
    // 首先尝试主URL
    const response = await fetch(DATA_CONFIG.DATA_URL, {
      headers: {
        'User-Agent': 'GeoIPGenerator/1.0',
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    data = await response.json();
    
  } catch (primaryError) {
    console.warn('Primary data source failed, trying backup:', primaryError);
    
    try {
      // 尝试备用URL
      const backupResponse = await fetch(DATA_CONFIG.BACKUP_URL, {
        headers: {
          'User-Agent': 'GeoIPGenerator/1.0',
          'Accept': 'application/json',
        },
      });
      
      if (!backupResponse.ok) {
        throw new Error(`Backup HTTP ${backupResponse.status}: ${backupResponse.statusText}`);
      }
      
      data = await backupResponse.json();
      
    } catch (backupError) {
      throw new Error(`Failed to load data from both primary and backup sources. Primary: ${primaryError}. Backup: ${backupError}`);
    }
  }

  // 验证数据格式
  if (!data.metadata || !Array.isArray(data.countries)) {
    throw new Error('Invalid data format received from remote source');
  }

  console.log(`✅ Loaded geo IP data: ${data.metadata.countries} countries, ${data.metadata.ipRanges} IP ranges`);

  // 更新缓存
  try {
    await cache.set(DATA_CONFIG.CACHE_KEY, 'latest', data, DATA_CONFIG.CACHE_TTL);
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }

  // 更新内存缓存
  memoryCache.data = data;
  memoryCache.timestamp = now;

  return data;
}

/**
 * 查找国家数据
 */
async function findCountry(query: string): Promise<CountryData | null> {
  const data = await loadGeoIpData();
  const normalizedQuery = query.toLowerCase().trim();

  // 精确匹配优先
  let country = data.countries.find(c => 
    c.id.toLowerCase() === normalizedQuery ||
    c.code2.toLowerCase() === normalizedQuery ||
    c.nameEn.toLowerCase() === normalizedQuery ||
    c.nameZh?.toLowerCase() === normalizedQuery
  );

  // 如果精确匹配失败，尝试模糊匹配
  if (!country) {
    country = data.countries.find(c => 
      c.nameEn.toLowerCase().includes(normalizedQuery) ||
      c.nameZh?.toLowerCase().includes(normalizedQuery)
    );
  }

  return country || null;
}

/**
 * 生成随机IP地址
 */
function generateRandomIpInRange(startIpInt: bigint, endIpInt: bigint): string {
  const range = endIpInt - startIpInt;
  const randomOffset = BigInt(Math.floor(Math.random() * Number(range + 1n)));
  const randomIpInt = startIpInt + randomOffset;
  
  // 转换为IP地址字符串
  const ip = Number(randomIpInt);
  return [
    (ip >>> 24) & 0xFF,
    (ip >>> 16) & 0xFF,
    (ip >>> 8) & 0xFF,
    ip & 0xFF
  ].join('.');
}

/**
 * 根据国家生成IP地址
 */
export async function generateIpByCountry(input: z.infer<typeof generateIpSchema>) {
  const { country: query, count } = input;

  // 查找国家
  const country = await findCountry(query);
  
  if (!country) {
    throw new Error(`Country not found: ${query}. Please use country code (CN, CHN) or country name (China, 中国).`);
  }

  if (!country.ipRanges || country.ipRanges.length === 0) {
    throw new Error(`No IP ranges available for ${country.nameEn} (${country.code2})`);
  }

  // 生成指定数量的IP地址（与 DB 版返回结构对齐）
  const generatedIps: Array<{
    ip: string;
    location: { region: string | null; city: string | null; isp: string | null };
    ipRange: { startIp: string; endIp: string };
  }> = [];
  
  for (let i = 0; i < count; i++) {
    // 随机选择一个IP段
    const randomRange = country.ipRanges[Math.floor(Math.random() * country.ipRanges.length)];
    
    if (!randomRange) {
      throw new Error(`No valid IP range found for ${country.nameEn}`);
    }
    
    // 在选定的IP段内生成随机IP
    const startIpInt = BigInt(randomRange.startIpInt);
    const endIpInt = BigInt(randomRange.endIpInt);
    const randomIp = generateRandomIpInRange(startIpInt, endIpInt);
    
    generatedIps.push({
      ip: randomIp,
      location: {
        region: null,
        city: null,
        isp: randomRange.isp ?? null,
      },
      ipRange: {
        startIp: randomRange.startIp,
        endIp: randomRange.endIp,
      },
    });
  }

  return {
    country: {
      id: country.id,
      code2: country.code2,
      nameEn: country.nameEn,
      nameZh: country.nameZh ?? undefined,
      continent: country.continent,
      region: country.region,
    },
    ips: generatedIps,
    totalRanges: country.ipRanges.length,
    cached: false,
  };
}

/**
 * 获取所有支持的国家列表
 */
export async function getCountries() {
  const data = await loadGeoIpData();
  
  return {
    success: true,
    countries: data.countries.map(c => ({
      code: c.code2,
      code3: c.id,
      name: c.nameEn,
      nameZh: c.nameZh,
      continent: c.continent,
      region: c.region,
      independent: c.independent,
      unMember: c.unMember,
      ipRanges: c.ipRanges.length,
    })),
    metadata: {
      total: data.countries.length,
      independent: data.countries.filter(c => c.independent).length,
      territories: data.countries.filter(c => !c.independent).length,
      lastUpdated: data.metadata.generatedAt,
      version: data.metadata.version,
    },
  };
}

/**
 * 获取数据统计信息
 */
export async function getDataStats() {
  const data = await loadGeoIpData();
  
  return {
    success: true,
    stats: data.metadata,
    dataSource: {
      url: DATA_CONFIG.DATA_URL,
      cached: memoryCache.data !== null,
      lastFetch: new Date(memoryCache.timestamp).toISOString(),
    },
  };
}
