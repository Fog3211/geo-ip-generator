import { db } from '~/server/db';

/**
 * AI-powered country name normalization service
 * Uses Groq API (free tier) for intelligent country name recognition
 * Falls back to enhanced fuzzy matching if API is unavailable
 */

interface CountryMatch {
  id: string; // 3-letter code (CHN, USA, etc.)
  code2: string; // 2-letter code (CN, US, etc.)
  nameEn: string;
  nameZh: string | null;
  confidence: number;
  method: 'ai' | 'fuzzy' | 'exact';
}

/**
 * Use Groq API to normalize country name to ISO code
 * Groq offers free tier: 30 requests/min, 14,400 requests/day
 */
async function normalizeWithAI(input: string): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  
  if (!apiKey) {
    return null; // Fall back to fuzzy matching
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', // Fast and free model
        messages: [
          {
            role: 'system',
            content: `You are a country name normalization assistant. Given any country name in any language or format, return ONLY the ISO 3166-1 alpha-2 country code (2 letters, uppercase). Examples: "China" -> "CN", "United States" -> "US", "日本" -> "JP", "Deutschland" -> "DE". If the input is ambiguous or not a valid country, return "UNKNOWN".`
          },
          {
            role: 'user',
            content: input.trim()
          }
        ],
        temperature: 0.1, // Low temperature for consistent results
        max_tokens: 5, // We only need 2-3 characters
      }),
    });

    if (!response.ok) {
      console.warn('Groq API error:', response.status, response.statusText);
      return null;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const code = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    
    if (code && code !== 'UNKNOWN' && code.length === 2) {
      return code;
    }
    
    return null;
  } catch (error) {
    console.warn('AI normalization failed, falling back to fuzzy matching:', error);
    return null;
  }
}

/**
 * Enhanced fuzzy matching with multiple strategies
 */
async function fuzzyMatchCountry(input: string): Promise<CountryMatch | null> {
  const normalizedInput = input.trim().toLowerCase();
  
  // Get all countries for fuzzy matching
  const allCountries = await db.country.findMany({
    select: {
      id: true,
      code2: true,
      nameEn: true,
      nameZh: true,
    },
  });

  // Scoring function
  const scoreMatch = (country: typeof allCountries[0]): number => {
    const nameEnLower = country.nameEn.toLowerCase();
    const nameZhLower = country.nameZh?.toLowerCase() ?? '';
    const code2Lower = country.code2.toLowerCase();
    const idLower = country.id.toLowerCase();
    
    let score = 0;
    
    // Exact matches get highest score
    if (nameEnLower === normalizedInput || nameZhLower === normalizedInput || 
        code2Lower === normalizedInput || idLower === normalizedInput) {
      return 100;
    }
    
    // Starts with match
    if (nameEnLower.startsWith(normalizedInput) || nameZhLower.startsWith(normalizedInput)) {
      score += 50;
    }
    
    // Contains match
    if (nameEnLower.includes(normalizedInput) || nameZhLower.includes(normalizedInput)) {
      score += 30;
    }
    
    // Code matches
    if (code2Lower === normalizedInput || idLower === normalizedInput) {
      score += 80;
    }
    
    // Partial code match
    if (code2Lower.includes(normalizedInput) || normalizedInput.includes(code2Lower)) {
      score += 20;
    }
    
    // Length similarity (shorter names are usually more specific)
    const lengthDiff = Math.abs(nameEnLower.length - normalizedInput.length);
    score -= lengthDiff * 2;
    
    return score;
  };

  // Score all countries
  const scored = allCountries
    .map(country => ({
      country,
      score: scoreMatch(country),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return null;
  }

  const bestMatch = scored[0];
  const confidence = Math.min(100, bestMatch.score);

  return {
    id: bestMatch.country.id,
    code2: bestMatch.country.code2,
    nameEn: bestMatch.country.nameEn,
    nameZh: bestMatch.country.nameZh,
    confidence,
    method: 'fuzzy',
  };
}

/**
 * Main function to normalize country input using AI + fuzzy matching
 */
export async function normalizeCountryInput(input: string): Promise<CountryMatch | null> {
  if (!input || !input.trim()) {
    return null;
  }

  const trimmed = input.trim();

  // First try exact match (fastest)
  const exactMatch = await db.country.findFirst({
    where: {
      OR: [
        { id: trimmed.toUpperCase() },
        { code2: trimmed.toUpperCase() },
        { nameEn: trimmed },
        { nameZh: trimmed },
      ],
    },
    select: {
      id: true,
      code2: true,
      nameEn: true,
      nameZh: true,
    },
  });

  if (exactMatch) {
    return {
      ...exactMatch,
      confidence: 100,
      method: 'exact',
    };
  }

  // Try AI normalization (if available)
  const aiCode = await normalizeWithAI(trimmed);
  if (aiCode) {
    const aiMatch = await db.country.findFirst({
      where: { code2: aiCode },
      select: {
        id: true,
        code2: true,
        nameEn: true,
        nameZh: true,
      },
    });

    if (aiMatch) {
      return {
        ...aiMatch,
        confidence: 95, // High confidence for AI matches
        method: 'ai',
      };
    }
  }

  // Fall back to fuzzy matching
  return await fuzzyMatchCountry(trimmed);
}

