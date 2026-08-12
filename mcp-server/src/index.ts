#!/usr/bin/env node

/**
 * ClearList MCP Server
 *
 * AI agent interface to ClearList, an AI resale manager.
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
import { registerUiResources } from './ui/register.js'

// ── Configuration ────────────────────────────────────────────────────────────
const API_URL = process.env.CLEARLIST_API_URL || 'https://clearlist.me'
const API_KEY = process.env.CLEARLIST_API_KEY
// CLEARLIST_SELLER_UID is deliberately NOT read.
//
// It was briefly live in Feb 2026 — required at first (ed05c7af), then
// optional (364aec3e) — and went dead in a merge that kept its const and
// doc line beside 1822790e's hardcoded `sellerUid: 'agent'`. No PUBLISHED
// version ever read it: all three commits were 0.1.0 and the first publish
// was 0.5.0. So the doc line promised "optional, for logging only" to every
// user who ever installed this package, and nothing honored it.
//
// Wiring it up now would change a published package's behaviour to satisfy
// a line that was never true of it. The client below hardcodes sellerUid
// because identity is resolved server-side from the API key, and the
// client's uid getter has no callers. noUnusedLocals surfaced the const;
// the doc line goes with it.

// ── Initialize ───────────────────────────────────────────────────────────────
const api = new ClearListApiClient({
  baseUrl: API_URL,
  sellerUid: 'agent', // Resolved server-side from API key
  apiKey: API_KEY,
})

/** Single source of truth for this file — the constructor and the startup log
 *  both read it, so they cannot drift apart. Keep in lockstep with the other
 *  version locations listed in PUBLISHING.md. */
const SERVER_VERSION = '0.9.2'

const server = new McpServer(
  {
    name: 'clearlist',
    version: SERVER_VERSION,
    title: 'ClearList',
    description:
      'AI resale manager. Photograph an item, AI writes the listing, publish a sale page, manage pickups.',
    websiteUrl: 'https://clearlist.me/developers',
    icons: [
      { src: 'https://clearlist.me/icons/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
      { src: 'https://clearlist.me/icons/icon-192.png', mimeType: 'image/png', sizes: ['192x192'] },
    ],
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
// MCP Apps (SEP-1865): the shared ui:// view for get_listings / publish_page /
// get_reservations. Hosts without UI support ignore it. Registered at the
// entry point (not inside registerSellerTools) so the tool modules stay free
// of relative value imports — see src/ui/register.ts header.
registerUiResources(server)

// Discovery tools (search_items, get_sales_near, get_city_sales)
// Read-only, Phase 14.
registerDiscoveryTools(server, api)

// ── Connect Transport ────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`ClearList MCP Server v${SERVER_VERSION}`)
  console.error(`  API: ${API_URL}`)
  if (API_KEY) {
    console.error(`  Auth: API key (${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)})`)
    console.error(`  Mode: Authenticated — all tools available`)
  } else {
    console.error(`  Auth: None yet`)
    console.error(`  Mode: Onboarding — use send_verification_code + verify_code to authenticate`)
  }
  console.error(`  Tools: 25 (2 onboarding + 20 seller + 3 discovery)`)
  console.error(`  Ready.`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
