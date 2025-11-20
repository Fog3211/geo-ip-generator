import { z } from 'zod';
import { db } from '~/server/db';
import { generateRandomIpInRange } from '~/lib/utils/ip-utils';
import { 
  withCache, 
  getCountryCacheKey, 
  getGenerationCacheKey 
} from '~/lib/cache';
import { CACHE_KEYS, CACHE_TTL } from '~/config';
import { normalizeCountryInput } from './ai-country-matcher';

// Input validation schemas
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

/**
 * Standard country matching function (fast, no AI)
 * Supports: country codes (CN, US, CHN, USA), exact names (China, 中国), and basic fuzzy matching
 */
async function findCountryStandard(query: string) {
  // Try exact matches first
  let country = await db.country.findFirst({
    where: {
      OR: [
        { id: query.toUpperCase() }, // 3-letter country code match (e.g., CHN, USA, JPN)
        { code2: query.toUpperCase() }, // 2-letter country code match (e.g., CN, US, JP)
        { nameEn: query }, // English name exact match
        { nameZh: query }, // Chinese name exact match
      ],
    },
    select: {
      id: true,
      code2: true,
      nameEn: true,
      nameZh: true,
      continent: true,
      region: true,
    },
  });

  // If no exact match found, try partial matches
  if (!country) {
    country = await db.country.findFirst({
      where: {
        OR: [
          { nameEn: { contains: query } }, // English name fuzzy match
          { nameZh: { contains: query } }, // Chinese name fuzzy match
        ],
      },
      select: {
        id: true,
        code2: true,
        nameEn: true,
        nameZh: true,
        continent: true,
        region: true,
      },
      // Order by name length to prefer shorter, more specific matches
      orderBy: [
        { nameZh: 'asc' },
        { nameEn: 'asc' }
      ]
    });
  }

  return country;
}

/**
 * Shared IP generation logic
 */
async function generateIpsForCountry(
  country: { id: string },
  count: number
): Promise<Array<{
  ip: string;
  location: {
    region: string | null;
    city: string | null;
    isp: string | null;
  };
  ipRange: {
    startIp: string;
    endIp: string;
  };
}>> {
  // Count total IP ranges for the country
  const totalRangesCount = await db.ipRange.count({
    where: { countryId: country.id },
  });

  if (totalRangesCount === 0) {
    throw new Error(`No IP range data available for country/region: ${country.id}. Please import real IP data first.`);
  }

  const generatedIps: Array<{
    ip: string;
    location: {
      region: string | null;
      city: string | null;
      isp: string | null;
    };
    ipRange: {
      startIp: string;
      endIp: string;
    };
  }> = [];

  for (let i = 0; i < count; i++) {
    // Random offset in [0, totalRangesCount)
    const offset = Math.floor(Math.random() * totalRangesCount);

    // Fetch exactly one range at the random offset with deterministic ordering
    const rows = await db.ipRange.findMany({
      where: { countryId: country.id },
      select: {
        startIp: true,
        endIp: true,
        region: { select: { name: true } },
        city: { select: { name: true } },
        isp: true,
      },
      orderBy: { id: 'asc' },
      skip: offset,
      take: 1,
    });

    const chosen = rows[0] ?? (await db.ipRange.findMany({
      where: { countryId: country.id },
      select: {
        startIp: true,
        endIp: true,
        region: { select: { name: true } },
        city: { select: { name: true } },
        isp: true,
      },
      orderBy: { id: 'asc' },
      skip: Math.max(0, totalRangesCount - 1),
      take: 1,
    }))[0];

    if (!chosen) {
      throw new Error('Failed to fetch a random IP range. Please retry.');
    }

    const randomIp = generateRandomIpInRange(chosen.startIp, chosen.endIp);

    generatedIps.push({
      ip: randomIp,
      location: {
        region: chosen.region?.name ?? null,
        city: chosen.city?.name ?? null,
        isp: chosen.isp ?? null,
      },
      ipRange: {
        startIp: chosen.startIp,
        endIp: chosen.endIp,
      },
    });
  }

  return generatedIps;
}

/**
 * Standard IP generation (fast, supports country codes and exact names only)
 * Use this for high-performance scenarios where input is standardized
 */
export async function generateIpByCountryStandard(input: z.infer<typeof generateIpSchema>) {
  const { country: query, count } = input;
  
  return await withCache(
    {
      prefix: CACHE_KEYS.GENERATED,
      identifier: getGenerationCacheKey(`std:${query}`, count)
    },
    CACHE_TTL.GENERATED,
    async () => {
      // Find country using standard matching (no AI)
      const country = await withCache(
        {
          prefix: CACHE_KEYS.COUNTRY,
          identifier: getCountryCacheKey(`std:${query}`)
        },
        CACHE_TTL.COUNTRY,
        async () => findCountryStandard(query)
      );

      if (!country) {
        throw new Error(`Country/region not found: ${query}. Please use country codes (CN, US, CHN, USA) or exact country names (China, 中国).`);
      }

      const generatedIps = await generateIpsForCountry(country, count);

      return {
        country: {
          id: country.id,
          code2: country.code2,
          nameEn: country.nameEn,
          nameZh: country.nameZh,
          continent: country.continent,
          region: country.region,
        },
        ips: generatedIps,
        totalRanges: await db.ipRange.count({ where: { countryId: country.id } }),
        cached: false,
      };
    }
  );
}

/**
 * AI-powered IP generation (supports natural language input)
 * Use this for flexible input scenarios where users may input various formats
 */
export async function generateIpByCountryAI(input: z.infer<typeof generateIpSchema>) {
  const { country: query, count } = input;
  
  return await withCache(
    {
      prefix: CACHE_KEYS.GENERATED,
      identifier: getGenerationCacheKey(`ai:${query}`, count)
    },
    CACHE_TTL.GENERATED,
    async () => {
      // Use AI-powered normalization for better recognition
      const country = await withCache(
        {
          prefix: CACHE_KEYS.COUNTRY,
          identifier: getCountryCacheKey(`ai:${query}`)
        },
        CACHE_TTL.COUNTRY,
        async () => {
          // Try AI-powered normalization first (handles natural language input)
          const normalized = await normalizeCountryInput(query);
          
          if (normalized) {
            // Fetch full country details using normalized code
            const country = await db.country.findFirst({
              where: { id: normalized.id },
              select: {
                id: true,
                code2: true,
                nameEn: true,
                nameZh: true,
                continent: true,
                region: true,
              },
            });
            
            if (country) {
              return country;
            }
          }

          // Fallback to standard matching
          return findCountryStandard(query);
        }
      );

      if (!country) {
        throw new Error(`Country/region not found: ${query}. Please try a different format or use the standard API with country codes.`);
      }

      const generatedIps = await generateIpsForCountry(country, count);

      return {
        country: {
          id: country.id,
          code2: country.code2,
          nameEn: country.nameEn,
          nameZh: country.nameZh,
          continent: country.continent,
          region: country.region,
        },
        ips: generatedIps,
        totalRanges: await db.ipRange.count({ where: { countryId: country.id } }),
        cached: false,
      };
    }
  );
}

/**
 * Backward compatibility: default to standard matching
 * @deprecated Use generateIpByCountryStandard or generateIpByCountryAI explicitly
 */
export async function generateIpByCountry(input: z.infer<typeof generateIpSchema>) {
  return generateIpByCountryStandard(input);
}

export async function getCountries() {
  return await withCache(
    {
      prefix: CACHE_KEYS.COUNTRY_LIST,
      identifier: 'all'
    },
    CACHE_TTL.COUNTRY_LIST,
    async () => {
      return await db.country.findMany({
        select: {
          id: true,
          code2: true,
          nameEn: true,
          nameZh: true,
          continent: true,
          region: true,
          _count: {
            select: {
              ipRanges: true,
            },
          },
        },
        orderBy: {
          nameEn: 'asc',
        },
      });
    }
  );
}

 