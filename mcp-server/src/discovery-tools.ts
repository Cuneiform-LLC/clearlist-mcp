/**
 * ClearList MCP — Buyer/Discovery Tools
 *
 * 3 tools for searching items across all sales. These map to Phase 14
 * (City Directory & Marketplace) API routes which are not yet built.
 *
 * The tools are registered now so agents can see them in the tool list,
 * and will return live data once the /api/search/* routes exist.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiResponse, ClearListApiClient } from './api-client.js'

/**
 * Detect a "route doesn't exist" response — i.e., Phase 14 not deployed —
 * vs. a real backend 404 from a route that DOES exist but reports a
 * missing resource (e.g., "City Atlantis not found" once Phase 14 ships).
 *
 * 404 status alone is not enough: once Phase 14 launches, real business-
 * logic 404s ("city not found", "item not found") would be misreported
 * as "feature not deployed" — swallowing the actual error.
 *
 * Distinguishing signal: the response BODY shape.
 *   - Route doesn't exist → Next.js's default HTML 404 page → response
 *     body starts with "<" (HTML tag). request()'s text-then-JSON-parse
 *     fallback puts the truncated HTML into result.error.
 *   - Empty body / no response error → request() synthesizes
 *     "HTTP 404: Not Found" as the error.
 *   - Real route returning 404 → JSON body like {"error": "City not found"}
 *     → result.error is the descriptive message.
 *
 * Heuristic: HTML body OR synthesized "HTTP 404" prefix → not deployed.
 * Anything else → real backend response, surface to agent.
 *
 * Gemini round-7 P1.
 */
function isPhase14NotDeployed(result: ApiResponse<unknown>): boolean {
  if (result.http_status !== 404) return false
  const error = (result.error || '').trim()
  // Empty error → synthesized by request() when no body
  if (!error) return true
  // HTML body (Next.js default 404 page) starts with `<`
  if (error.startsWith('<')) return true
  // request() synthesizes this when status is non-OK with no body error
  if (/^HTTP 404(\b|:)/i.test(error)) return true
  // Anything else: real route, real error message — surface it
  return false
}

function notImplementedResponse(message: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: 'NOT_IMPLEMENTED', message }, null, 2),
    }],
  }
}

function errorResponse(error: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: 'BACKEND_ERROR', message: error }, null, 2),
    }],
  }
}

export function registerDiscoveryTools(
  server: McpServer,
  api: ClearListApiClient,
): void {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. search_items
  // ─────────────────────────────────────────────────────────────────────────
  // TODO(phase-14): Wire to /api/search/items when city directory is deployed.
  server.registerTool('search_items', {
    title: 'Search Items',
    description:
      '[NOT IMPLEMENTED — Phase 14] Search for items across all published ClearList sales. Filter by keyword, city, category, and price range. Returns matching items with links to their sale pages.',
    inputSchema: {
      query: z.string().optional().describe('Search query (matches title and description)'),
      city: z.string().optional().describe('City name to search in'),
      category: z
        .enum([
          'Furniture', 'Electronics', 'Kitchen', 'Decor', 'Outdoor',
          'Baby', 'Sports', 'Tools', 'Clothing', 'Other',
        ])
        .optional()
        .describe('Filter by category'),
      max_price: z.number().optional().describe('Maximum price in dollars'),
      min_price: z.number().optional().describe('Minimum price in dollars'),
      limit: z.number().optional().describe('Max results to return (default 20)'),
    },
    annotations: {
      title: 'Search Items',
      readOnlyHint: true,
    },
  }, async (args) => {
    // Try the search API route (Phase 14)
    const params: Record<string, string> = {}
    if (args.query) params.q = args.query
    if (args.city) params.city = args.city
    if (args.category) params.category = args.category
    if (args.max_price !== undefined) params.max_price = String(args.max_price)
    if (args.min_price !== undefined) params.min_price = String(args.min_price)
    if (args.limit !== undefined) params.limit = String(args.limit)

    const result = await api.get('/api/search/items', params)

    if (!result.success) {
      if (isPhase14NotDeployed(result)) {
        return notImplementedResponse(
          'Item search is not yet available. The ClearList city directory (Phase 14) needs to be deployed first.',
        )
      }
      return errorResponse(result.error ?? 'Unknown error from /api/search/items')
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result.data, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 2. get_sales_near
  // ─────────────────────────────────────────────────────────────────────────
  // TODO(phase-14): Wire to /api/search/sales when city directory is deployed.
  server.registerTool('get_sales_near', {
    title: 'Get Sales Near Location',
    description:
      '[NOT IMPLEMENTED — Phase 14] Find active moving sales near a given city or location. Returns a list of sales with seller names, item counts, and page URLs.',
    inputSchema: {
      city: z.string().describe('City name (e.g., "Austin, TX")'),
      radius_miles: z
        .number()
        .optional()
        .describe('Search radius in miles (default 25)'),
    },
    annotations: {
      title: 'Get Sales Near Location',
      readOnlyHint: true,
    },
  }, async (args) => {
    const params: Record<string, string> = { city: args.city }
    if (args.radius_miles !== undefined) params.radius = String(args.radius_miles)

    const result = await api.get('/api/search/sales', params)

    if (!result.success) {
      if (isPhase14NotDeployed(result)) {
        return notImplementedResponse(
          'Location-based sale discovery is not yet available. The ClearList city directory (Phase 14) needs to be deployed first.',
        )
      }
      return errorResponse(result.error ?? 'Unknown error from /api/search/sales')
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result.data, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 3. get_city_sales
  // ─────────────────────────────────────────────────────────────────────────
  // TODO(phase-14): Wire to /api/cities/sales when city directory is deployed.
  server.registerTool('get_city_sales', {
    title: 'Get City Sales',
    description:
      '[NOT IMPLEMENTED — Phase 14] Get all active sales in a specific city. Returns seller names, item counts, categories, and page URLs.',
    inputSchema: {
      city: z.string().describe('City name (e.g., "Austin" or "Austin, TX")'),
    },
    annotations: {
      title: 'Get City Sales',
      readOnlyHint: true,
    },
  }, async ({ city }) => {
    const result = await api.get('/api/cities/sales', { city })

    if (!result.success) {
      if (isPhase14NotDeployed(result)) {
        return notImplementedResponse(
          'City sales directory is not yet available. The ClearList city directory (Phase 14) needs to be deployed first.',
        )
      }
      return errorResponse(result.error ?? 'Unknown error from /api/cities/sales')
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result.data, null, 2),
      }],
    }
  })
}
