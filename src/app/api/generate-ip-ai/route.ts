import { NextRequest, NextResponse } from 'next/server';
import { generateIpByCountryAI, generateIpSchema } from '~/lib/services/ip-service';
import { withRateLimit } from '~/lib/middleware/rate-limit-middleware';

/**
 * Generate random IP addresses by country/region (AI-powered API)
 * 
 * This endpoint uses AI to recognize country names in various formats:
 * - Multiple languages: "Deutschland", "日本", "United States"
 * - Natural language: "I want IPs from Germany"
 * - Various formats: "USA", "US", "United States", "America"
 * 
 * For standard formats (codes, exact names), use /api/generate-ip for better performance
 * 
 * Security measures:
 * - IP rate limiting (5 requests per minute - lower due to AI processing)
 * - Parameter validation with regex patterns
 * - Count limited to 1-10 (matches frontend)
 * - Input sanitization and length limits
 * 
 * Query parameters:
 * - country: Country name in any language or format (required)
 * - count: Number of IPs to generate (1-10, default: 1)
 * 
 * Examples:
 * GET /api/generate-ip-ai?country=Deutschland&count=3
 * GET /api/generate-ip-ai?country=日本&count=1
 * GET /api/generate-ip-ai?country=United States&count=2
 */
async function handleGenerateIPAI(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Additional security: Check if too many parameters (prevent parameter pollution)
    if (searchParams.toString().length > 200) {
      return NextResponse.json(
        {
          error: 'Request too large',
          message: 'Query string exceeds maximum length'
        },
        { status: 400 }
      );
    }

    // Parse and validate input with strict validation
    const result = generateIpSchema.safeParse({
      country: searchParams.get('country'),
      count: searchParams.get('count'),
    });

    if (!result.success) {
      return NextResponse.json(
        {
          error: 'Invalid parameters',
          message: 'Please check your country and count parameters',
          details: result.error.issues.map(issue => ({
            field: issue.path[0],
            message: issue.message
          }))
        },
        { status: 400 }
      );
    }

    // Call AI-powered service function
    const response = await generateIpByCountryAI({
      country: result.data.country,
      count: result.data.count,
    });

    // Return clean REST response
    return NextResponse.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Generate IP AI API error:', error);

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

// Export the rate-limited handler (lower rate limit for AI endpoint)
export const GET = withRateLimit(handleGenerateIPAI, 'generate-ip-ai');

