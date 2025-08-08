/**
 * IP Rate Limiting Middleware
 * Provides IP-based rate limiting using Redis backend
 */

import { NextRequest, NextResponse } from 'next/server';
import { incrementRateLimit, getRateLimitCount } from '~/lib/cache';
import { RATE_LIMITS } from '~/config';
import type { RateLimitEndpoint, RateLimitInfo } from '~/types';

/**
 * Extract client IP address from request
 */
function getClientIP(request: NextRequest): string {
  // Check various headers for the real IP
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfConnectingIP = request.headers.get('cf-connecting-ip');
  const clientIP = request.headers.get('x-client-ip');
  
  // Return the first available IP
  if (forwardedFor) {
    // x-forwarded-for can contain multiple IPs, take the first one
    return forwardedFor.split(',')[0]?.trim() || '';
  }
  
  if (realIP) return realIP;
  if (cfConnectingIP) return cfConnectingIP;
  if (clientIP) return clientIP;
  
  // Fallback to unknown if no IP headers are available
  return 'unknown';
}

/**
 * Extract endpoint name from request URL
 */
function getEndpointName(request: NextRequest): string {
  const pathname = new URL(request.url).pathname;
  
  // Extract endpoint from API path
  const match = pathname.match(/\/api\/([^\/]+)/);
  if (match?.[1]) {
    return match[1];
  }
  
  return 'default';
}

/**
 * Rate limiting middleware
 */
export async function rateLimitMiddleware(
  request: NextRequest,
  endpoint?: string
): Promise<NextResponse | null> {
  try {
    // Get client IP and endpoint
    const clientIP = getClientIP(request);
    const endpointName = endpoint || getEndpointName(request);
    
    // Skip rate limiting for localhost in development
    if (process.env.NODE_ENV === 'development' && 
        (clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === 'localhost')) {
      return null; // Allow request to continue
    }
    
    // Get rate limit config for this endpoint
    const config = RATE_LIMITS[endpointName as RateLimitEndpoint] || RATE_LIMITS.default;
    
    // Check current request count
    const currentCount = await incrementRateLimit(clientIP, endpointName, config.ttl);
    
    // If Redis is not available, allow request (fail open)
    if (currentCount === 0) {
      return null;
    }
    
    // Check if limit exceeded
    if (currentCount > config.requests) {
      console.warn(`Rate limit exceeded for IP ${clientIP} on endpoint ${endpointName}: ${currentCount}/${config.requests}`);
      
      return NextResponse.json(
        {
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Max ${config.requests} requests per minute allowed.`,
          retryAfter: Math.ceil(config.windowMs / 1000),
          timestamp: new Date().toISOString(),
        },
        { 
          status: 429,
          headers: {
            'X-RateLimit-Limit': config.requests.toString(),
            'X-RateLimit-Remaining': Math.max(0, config.requests - currentCount).toString(),
            'X-RateLimit-Reset': new Date(Date.now() + config.windowMs).toISOString(),
            'Retry-After': Math.ceil(config.windowMs / 1000).toString(),
          }
        }
      );
    }
    
    // Request is within limits, allow it to continue
    return null;
    
  } catch (error) {
    console.error('Rate limiting middleware error:', error);
    // On error, allow request to continue (fail open)
    return null;
  }
}

/**
 * Higher-order function to wrap API routes with rate limiting
 */
export function withRateLimit(
  handler: (request: NextRequest) => Promise<NextResponse>,
  endpoint?: string
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Apply rate limiting
    const rateLimitResponse = await rateLimitMiddleware(request, endpoint);
    
    // If rate limited, return the rate limit response
    if (rateLimitResponse) {
      return rateLimitResponse;
    }
    
    // Otherwise, continue with the original handler
    const response = await handler(request);

    // After successful handling, attach rate limit headers as well
    try {
      const clientIP = getClientIP(request);
      const endpointName = endpoint || getEndpointName(request);
      const config = RATE_LIMITS[endpointName as RateLimitEndpoint] || RATE_LIMITS.default;

      // Fetch current usage (may be 0 if Redis disabled)
      const currentCount = await getRateLimitCount(clientIP, endpointName);
      const limit = config.requests;
      const remaining = Math.max(0, limit - currentCount);
      const resetAt = new Date(Date.now() + config.windowMs).toISOString();

      response.headers.set('X-RateLimit-Limit', String(limit));
      response.headers.set('X-RateLimit-Remaining', String(remaining));
      response.headers.set('X-RateLimit-Reset', resetAt);
      // Do not set Retry-After on success; it's meaningful when rejecting
    } catch (err) {
      // Fail open: do not block response if headers setting failed
      console.warn('Failed to attach rate limit headers:', err);
    }

    return response;
  };
}



/**
 * Get rate limit information for debugging
 */
export function getRateLimitInfo(endpoint: string): RateLimitInfo {
  const config = RATE_LIMITS[endpoint as RateLimitEndpoint] || RATE_LIMITS.default;
  
  return {
    limit: config.requests,
    remaining: config.requests, // This would need to be calculated based on current usage
    reset: new Date(Date.now() + config.windowMs).toISOString(),
    endpoint,
  };
} 