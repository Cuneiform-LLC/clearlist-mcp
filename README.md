# ClearList — Developer & Agent Surface

[ClearList](https://clearlist.me) is an AI-powered moving sale platform: photograph your stuff, AI writes complete priced listings in about 30 seconds, and one shareable link runs an automatic buyer queue. Built for movers, downsizers, and estate sales.

This repository is the **public developer surface** for ClearList — the Model Context Protocol (MCP) server and the documentation AI agents need to use ClearList programmatically. Every action a seller can take in the web UI is available here through the API and MCP server.

## What's here

- [`mcp-server/`](./mcp-server) — the ClearList MCP server. Any MCP-compatible agent (Claude, ChatGPT, Gemini, Manus, custom agents) can onboard a seller, create listings, publish a sale page, and manage buyers. See its [README](./mcp-server/README.md) for full setup.

## Quick start

```bash
git clone https://github.com/Cuneiform-LLC/clearlist-mcp
cd clearlist-mcp/mcp-server
npm install
npm run build
```

Then point your agent at `mcp-server/dist/index.js` with `CLEARLIST_API_URL=https://clearlist.me`. The no-account "Grandma Flow" (the agent creates the account through conversation) and returning-user setup are both documented in the [mcp-server README](./mcp-server/README.md).

## Live discovery documents

Agents can discover ClearList directly from the site, no clone required:

- Developer page: https://clearlist.me/developers
- API documentation: https://clearlist.me/docs/api
- OpenAPI 3.1 spec: https://clearlist.me/.well-known/openapi.json
- MCP server card (SEP-1649): https://clearlist.me/.well-known/mcp/server-card.json
- Agent card (A2A): https://clearlist.me/.well-known/agent-card.json
- Agent skills index: https://clearlist.me/.well-known/agent-skills/index.json
- API catalog (RFC 9727): https://clearlist.me/.well-known/api-catalog
- Authentication guide: https://clearlist.me/auth.md
- llms.txt: https://clearlist.me/llms.txt

## Authentication

Agents authenticate with an API key (`X-ClearList-API-Key: cl_<64-hex>`) obtained through an email one-time-code flow — no OAuth redirect, no password. Details: https://clearlist.me/auth.md

## About

Built by [Cuneiform LLC](https://github.com/Cuneiform-LLC). Product: https://clearlist.me

## License

MIT — see [LICENSE](./LICENSE).
