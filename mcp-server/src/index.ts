#!/usr/bin/env node

/**
 * ClearList MCP Server
 *
 * AI agent interface to the ClearList moving sale platform.
 *
 * Any AI agent (ChatGPT, Gemini, Claude, Manus) can use this to manage
 * moving sales on behalf of users. The user never needs to visit clearlist.me.
 *
 * TWO WAYS TO START:
 *
 * 1. WITH API KEY (returning seller):
 *    Agent already has an API key from a previous session.
 *    Set CLEARLIST_API_KEY and all tools work immediately.
 *
 * 2. WITHOUT API KEY (new user — the grandma flow):
 *    Agent starts with no key. Only onboarding tools are available:
 *      send_verification_code → verify_code
 *    Once verified, the server auto-receives an API key and all tools unlock.
 *
 * Any AI agent (ChatGPT, Gemini, Claude, Manus) can use ClearList as
 * their infrastructure for managing moving sales.
 *
 * Configuration (environment variables):
 *   CLEARLIST_API_URL     — Base URL (default: https://clearlist.me)
 *   CLEARLIST_API_KEY     — API key (optional — can be acquired via onboarding)
 *   CLEARLIST_SELLER_UID  — Firebase UID (optional, for logging only)
 *
 * Usage with Claude Desktop:
 *   {
 *     "mcpServers": {
 *       "clearlist": {
 *         "command": "node",
 *         "args": ["path/to/mcp-server/dist/index.js"],
 *         "env": {
 *           "CLEARLIST_API_URL": "https://clearlist.me",
 *           "CLEARLIST_API_KEY": "cl_your_key_or_omit_for_onboarding"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ClearListApiClient } from './api-client.js'
import { registerOnboardingTools } from './onboarding-tools.js'
import { registerSellerTools } from './seller-tools.js'
import { registerDiscoveryTools } from './discovery-tools.js'

// ── Configuration ────────────────────────────────────────────────────────────
const API_URL = process.env.CLEARLIST_API_URL || 'https://clearlist.me'
const API_KEY = process.env.CLEARLIST_API_KEY
const SELLER_UID = process.env.CLEARLIST_SELLER_UID || 'agent'

// ── Initialize ───────────────────────────────────────────────────────────────
const api = new ClearListApiClient({
  baseUrl: API_URL,
  sellerUid: 'agent', // Resolved server-side from API key
  apiKey: API_KEY,
})

const server = new McpServer(
  {
    name: 'clearlist',
    version: '0.3.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

// ── Register All Tools ───────────────────────────────────────────────────────
// Onboarding tools (send_verification_code, verify_code) — always available,
// work without an API key. This is how new users get started.
registerOnboardingTools(server, api)

// Seller tools (create_listing, bulk_create_listings, publish_page, etc.)
// These require an API key — either from env or from verify_code.
registerSellerTools(server, api)

// Discovery tools (search_items, get_sales_near, get_city_sales)
// Read-only, Phase 14.
registerDiscoveryTools(server, api)

// ── Connect Transport ────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`ClearList MCP Server v0.3.0`)
  console.error(`  API: ${API_URL}`)
  if (API_KEY) {
    console.error(`  Auth: API key (${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)})`)
    console.error(`  Mode: Authenticated — all tools available`)
  } else {
    console.error(`  Auth: None yet`)
    console.error(`  Mode: Onboarding — use send_verification_code + verify_code to authenticate`)
  }
  console.error(`  Tools: 24 (2 onboarding + 19 seller + 3 discovery)`)
  console.error(`  Ready.`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
