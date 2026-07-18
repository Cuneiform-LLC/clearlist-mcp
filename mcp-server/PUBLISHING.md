# Publishing ClearList to MCP registries (Tier 1 — discovery)

These are the self-serve registries that index your server so agents and users
can find it. None of them require OAuth 2.0 — they just index metadata. Do these
**after PR #339 is merged and deployed** so the remote endpoint
(`https://clearlist.me/api/mcp`) is live.

Prereqs already met: npm package `@clearlist/mcp-server` is public; privacy
policy at `/privacy`; tools carry `title` + `readOnlyHint`/`destructiveHint`;
`server.json` + `smithery.yaml` are in this folder.

---

## 0. Republish the npm package (one-time — adds `mcpName`)

The MCP registry verifies the *published* npm package's `package.json` contains
an `mcpName` field. We just added it and bumped to `0.3.1`. npm won't let you
overwrite a published version, hence the bump.

```bash
cd mcp-server
npm install
npm run build
npm publish --access public          # publishes 0.3.1 with mcpName
```

Verify: <https://www.npmjs.com/package/@clearlist/mcp-server> shows `0.3.1`.

---

## 1. MCP Official Registry (the hub — feeds Smithery, PulseMCP, Docker, Anthropic, GitHub)

Install the publisher CLI (Windows PowerShell):

```powershell
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.tar.gz" -OutFile mcp-publisher.tar.gz
tar xf mcp-publisher.tar.gz
# move mcp-publisher.exe somewhere on your PATH
```

Publish (from the `mcp-server/` folder, where `server.json` lives):

```bash
mcp-publisher login github     # device-code login; you must be an admin of the Cuneiform-LLC org
mcp-publisher publish          # reads ./server.json
```

Verify:
```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Cuneiform-LLC/clearlist"
```

**Namespace note:** `server.json` uses `io.github.Cuneiform-LLC/clearlist` (GitHub
auth — simplest; the login just has to be an org admin). If you'd rather have the
prettier `me.clearlist/clearlist`, switch to DNS auth instead: add a TXT record on
`clearlist.me`, change `name` in `server.json` + `mcpName` in `package.json` to
`me.clearlist/clearlist`, and run `mcp-publisher login dns` before `publish`.

---

## 2. Smithery (also a distribution channel — plumbs auth for users)

Publish the **hosted** endpoint (recommended — you already host it):

```bash
npx @smithery/cli login          # or: smithery login
smithery mcp publish https://clearlist.me/api/mcp -n clearlist/clearlist
```

The `smithery.yaml` in this folder additionally exposes the **npm/stdio** install
path with an API-key prompt, for users who want to run it locally.

---

## 3. mcp.so (community directory)

No CLI — open <https://mcp.so/>, click **Submit** in the nav (files a GitHub
issue), and provide: name `ClearList`, description (copy the one in `server.json`),
homepage `https://clearlist.me/developers`, repo
`https://github.com/Cuneiform-LLC/clearlist-mcp`, remote endpoint
`https://clearlist.me/api/mcp`, npm `@clearlist/mcp-server`.

---

## 4. PulseMCP / Glama (no action needed)

Both auto-ingest from the Official Registry (step 1). Give them a day, then
search your name on each to confirm the listing appeared.

---

## Gemini (low priority)

The Gemini **CLI extensions gallery** is self-serve (public git repo + a
`gemini-extension.json` manifest pointing at the remote endpoint), but it's being
folded into "Antigravity CLI." The consumer Gemini **Spark** connector surface is
**partnership-only** — no submit button. Skip unless a Google contact opens up.

---

For the **official in-product directories** (Claude Connectors Directory, ChatGPT
Apps) see the separate Tier-2 doc — those require a real OAuth 2.0 layer first.
