# ClearList MCP Server

AI agent interface to the ClearList moving sale platform. Any MCP-compatible agent (Claude, ChatGPT, Gemini, Manus, custom agents) can create listings, publish sale pages, and manage reservations — all through the same API routes the web UI uses.

**Users never need to visit clearlist.me.** The agent handles account creation, photo processing, listing generation, and publishing entirely through conversation.

## Quick Start

```bash
cd mcp-server
npm install
npm run build
```

## CLI

The package also ships a `clearlist` command-line tool for scripting seller
actions directly against the REST API — no MCP host required:

```bash
npm install -g @clearlist/mcp-server

clearlist login you@example.com        # send a 6-digit sign-in code
clearlist verify you@example.com 123456  # store the API key in ~/.clearlist/config.json
clearlist items                        # list your listings
clearlist publish --city "Austin"      # publish the sale page, get the URL
clearlist reservations                 # who reserved what
clearlist reply <conversationId> "Yes, still available"
clearlist picked-up <itemId>           # mark an item sold
clearlist status                       # plan, capacity, expiry
```

Every command prints JSON (pipe to `jq` for scripting). `CLEARLIST_API_KEY`
overrides the stored key; `CLEARLIST_API_URL` overrides the default
`https://clearlist.me`. Run `clearlist help` for the full reference.

## Two Ways to Connect

### Option A: New user (no account yet)

No API key needed. The agent creates the account through conversation:

```json
{
  "mcpServers": {
    "clearlist": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "CLEARLIST_API_URL": "https://clearlist.me"
      }
    }
  }
}
```

The agent uses `send_verification_code` + `verify_code` to authenticate. An API key is generated automatically and stored in memory for the session.

### Option B: Returning user (has API key)

If the agent already has a key from a previous session:

```json
{
  "mcpServers": {
    "clearlist": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "CLEARLIST_API_URL": "https://clearlist.me",
        "CLEARLIST_API_KEY": "cl_your_api_key_here"
      }
    }
  }
}
```

All tools work immediately — no onboarding needed.

## How It Works (The Grandma Flow)

```
Grandma → ChatGPT: "I'm moving, help me sell my stuff"
ChatGPT: "Sure! What's your email?"
Grandma: "grandma@gmail.com"

    [agent calls send_verification_code({ email: "grandma@gmail.com" })]

ChatGPT: "I sent you a 6-digit code. Check your email."
Grandma: "482019"

    [agent calls verify_code({ email: "grandma@gmail.com", code: "482019" })]
    → account created, API key returned, all tools unlocked

ChatGPT: "Account created! Now send me photos of everything you want to sell."
Grandma: [sends 20 photos]

    [agent calls bulk_create_listings({ photos: [...20 photos] })]
    → AI groups by item, generates listings, researches prices, validates

ChatGPT: "I found 12 items. Here's what I got:
          1. IKEA Kallax Shelf — $45 (Good condition)
          2. KitchenAid Mixer — $120 (Like New)
          ...
          Want me to publish your sale page?"

Grandma: "Yes! I'm in Austin."

    [agent calls publish_page({ city: "Austin", state: "TX" })]

ChatGPT: "Done! Your sale page is live at clearlist.me/grandmas-sale
          Share this link on Facebook or Nextdoor."
```

**Grandma never visited a website. Never generated an API key. Never created an account manually.**

## Available Tools (24)

### Onboarding Tools (2) — No API key required

| Tool | Description |
|------|-------------|
| `send_verification_code` | Send a 6-digit code to an email address |
| `verify_code` | Verify the code, create account if new, get API key |

### Seller Tools (19)

| Tool | Description |
|------|-------------|
| `create_listing` | Send 1-5 photos → AI generates listing → saves to account |
| `bulk_create_listings` | Send up to 50 photos → AI groups, generates, prices, QA-checks → saves all |
| `edit_listing` | Update any field on a listing |
| `delete_listing` | Permanently remove a listing |
| `publish_page` | Publish sale page with city, get shareable URL |
| `unpublish_page` | Take sale page offline |
| `get_listings` | List all items with status, price, queue count |
| `get_reservations` | See buyer reservations, messages, timer status |
| `get_conversation` | Get full message thread with a specific buyer |
| `reply_to_buyer` | Send message to a buyer |
| `share_address` | Share pickup address with a buyer (privacy-sensitive) |
| `mark_picked_up` | Mark item as sold |
| `confirm_pickup` | Confirm a scheduled pickup |
| `get_page_stats` | Page views, item count, reservation stats |
| `prepare_crosspost` | Generate cross-posting content for Craigslist/Facebook |
| `set_availability` | Configure pickup scheduling windows |
| `get_profile` | Get account profile and tier info |
| `check_tier_status` | Check subscription tier and limits |
| `generate_payment_link` | Generate Stripe payment link for upgrades |

### Discovery Tools (3) — Phase 14

| Tool | Description |
|------|-------------|
| `search_items` | Search items across all sales by keyword, city, category, price |
| `get_sales_near` | Find active sales near a location |
| `get_city_sales` | Browse all sales in a city |

## Architecture

```
User (via any AI agent)
  │
  ▼
Agent (ChatGPT, Claude, Gemini, Manus, etc.)
  │
  ▼
ClearList MCP Server (this package)
  │  stdio transport
  │
  ▼
ClearList API Routes (/api/*)
  │  HTTP + X-ClearList-API-Key header
  │
  ▼
Firebase (Firestore, Auth, Storage) + Gemini AI
```

The MCP server is a thin protocol adapter. Zero business logic — everything lives in the API routes.

## Authentication Flow

```
                    ┌─────────────────────────────────┐
                    │   Agent starts (no API key)      │
                    └─────────────┬───────────────────┘
                                  │
                    ┌─────────────▼───────────────────┐
                    │  send_verification_code          │
                    │  POST /api/auth/send-code        │
                    │  { email: "user@email.com" }     │
                    └─────────────┬───────────────────┘
                                  │  ← email sent with 6-digit code
                    ┌─────────────▼───────────────────┐
                    │  verify_code                     │
                    │  POST /api/auth/verify-code      │
                    │  { email, code, agent: true }    │
                    └─────────────┬───────────────────┘
                                  │  ← creates account + returns API key
                    ┌─────────────▼───────────────────┐
                    │  API key stored in memory        │
                    │  All subsequent calls use it     │
                    │  X-ClearList-API-Key: cl_xxx     │
                    └─────────────────────────────────┘
```

## Development

```bash
# Type-check
npm run type-check

# Build
npm run build

# Run directly (for testing)
CLEARLIST_API_URL=http://localhost:3000 npm run dev
```
