/**
 * Bundle the MCP App views into self-contained HTML and emit the COMPLETE
 * src/ui/register.ts module (committed).
 *
 * Why the whole module is generated: register.ts is imported as a VALUE by
 * both runtimes — node dist (stdio server, needs `.js` import specifiers)
 * and the Next.js remote endpoint (bundler, resolves extensionless .ts).
 * Files on that dual path must have no relative value imports of their own
 * (the same invariant that keeps seller-tools' api-client import type-only),
 * so the HTML is inlined here instead of imported from a sibling module.
 *
 * Run: npm run build:ui   (from mcp-server/)
 */
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every colour IN THIS STYLESHEET goes through a token, with two deliberate
// exceptions: `.us-qr` (a QR needs a light background to scan) and `.unread`.
// Inline styles built in views/ bypass tokens entirely and are NOT theme-aware
// — `STATUS_STYLES` in shared.ts and `DOT` in listings.ts. Saturated enough to
// read on both grounds today; revisit if either grows a pale value.
//
// Light is the bare :root default; dark is applied twice, once for hosts that
// never send a theme (guarded so an explicit light still wins) and once for
// `data-mode`, which mountView() sets from the host's own signal. mountView()
// is the accurate one — see its applyTheme() for why the media query alone is
// not enough, and for why it sets `data-theme` alongside `data-mode`.
const BASE_CSS = `
  :root{
    --fg:#1F2937;--fg2:#6B7280;--fg3:#9CA3AF;--fg4:#4B5563;
    --surface:#ffffff;--chip:#F3F4F6;
    --line:#E5E7EB;--line-soft:#F3F4F6;
    --link:#2563EB;--warn:#A16207;--ok:#166534;--ok-bg:#DCFCE7;--err:#DC2626;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-mode="light"]){
      --fg:#ECECE9;--fg2:#A3A39F;--fg3:#8A8A86;--fg4:#B8B8B4;
      --surface:#262624;--chip:#343432;
      --line:#3D3D3A;--line-soft:#333331;
      --link:#8AB0F7;--warn:#D5A94F;--ok:#79C695;--ok-bg:#1E3A2A;--err:#F0857D;
    }
  }
  :root[data-mode="dark"]{
    --fg:#ECECE9;--fg2:#A3A39F;--fg3:#8A8A86;--fg4:#B8B8B4;
    --surface:#262624;--chip:#343432;
    --line:#3D3D3A;--line-soft:#333331;
    --link:#8AB0F7;--warn:#D5A94F;--ok:#79C695;--ok-bg:#1E3A2A;--err:#F0857D;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;color:var(--fg);background:transparent;padding:12px}
  .head{font-size:13px;font-weight:600;color:var(--fg2);margin-bottom:10px}
  .empty,.error{padding:20px;text-align:left;color:var(--fg2);font-size:14px}
  .error{color:var(--err)}
  .card{border:1px solid var(--line);background:var(--surface);overflow:hidden}
  .card .body{padding:8px 10px}
  .ls-panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .ls-sum{display:flex;flex-wrap:wrap;gap:18px;padding-bottom:10px;border-bottom:1px solid var(--line)}
  .ls-sum div{font-size:11px;color:var(--fg2)}
  .ls-sum b{display:block;font-size:17px;font-weight:700;color:var(--fg)}
  .ls-list{margin-top:2px}
  .ls-note{margin-top:12px;font-size:12px;color:var(--warn)}
  .ls-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line-soft)}
  .ls-row:last-child{border-bottom:none}
  .ls-dot{width:6px;height:6px;border-radius:9999px;flex:none}
  .ls-p{font-size:14px;font-weight:700;color:var(--link);width:56px;flex:none;text-align:right}
  .ls-t{font-size:13px;color:var(--fg);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ls-a{color:var(--fg);text-decoration:underline}
  .ls-q{font-size:11px;color:var(--warn);flex:none}
  .ls-m{font-size:11px;color:var(--fg3);flex:none}
  .ls-foot{margin-top:12px;font-size:12px}
  .ls-foot .ls-a{color:var(--link)}
  .row{display:flex;align-items:center;justify-content:space-between;gap:6px}
  .price{color:var(--link);font-weight:700;font-size:14px}
  .title{font-size:13px;font-weight:500;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .meta{font-size:11px;color:var(--fg3);margin-top:2px}
  .publish{padding:20px;text-align:left}
  .check{width:36px;height:36px;border-radius:9999px;background:var(--ok-bg);color:var(--ok);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;margin-bottom:10px}
  .msg{font-size:15px;font-weight:600;margin-bottom:8px}
  .url{color:var(--link);font-size:14px;word-break:break-all;text-decoration:underline}
  .hint{font-size:12px;color:var(--fg3);margin-top:10px}
  .res{border:1px solid var(--line);background:var(--surface);padding:10px 12px;margin-bottom:8px}
  .buyer{font-weight:600;font-size:13px}
  .unread{background:#2563EB;color:#fff;border-radius:9999px;font-size:10px;font-weight:700;padding:1px 6px;margin-left:6px}
  .items{font-size:12px;color:var(--fg4);margin-top:3px}
  .last{font-size:12px;color:var(--fg3);font-style:italic;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pickup{font-size:12px;color:var(--ok);margin-top:3px}
  .upload-session{padding:18px 20px;text-align:left}
  .us-title{font-size:15px;font-weight:600;margin-bottom:12px}
  .us-qr{background:#fff;border:1px solid var(--line);padding:10px;display:inline-block;line-height:0}
  .us-sub{font-size:13px;color:var(--fg4);margin-top:12px;max-width:340px}
  /* The "why a QR code" line. --fg2 sits between .us-sub's --fg4 (the loudest,
     it is the instruction) and .us-meta's --fg3 (the quietest, those are
     constraints), which is the hierarchy this line wants. NOT --fg3: that made
     it identical to .us-meta and, on the white QR-panel ground, ~2.56:1 —
     under WCAG AA for body text a seller actually reads. --fg2 clears it. */
  .us-why{font-size:12px;line-height:1.45;color:var(--fg2);margin-top:10px;max-width:340px}
  .us-meta{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--fg3);margin-top:10px}
  .us-fallback{margin-top:12px;font-size:12px;color:var(--fg2)}
  .us-fallback summary{cursor:pointer}
  .us-fallback a{display:block;margin-top:6px;color:var(--link);word-break:break-all}
  .us-unverified{margin-top:10px;font-size:12px;color:var(--warn)}
  .us-rawurl{display:block;margin-top:6px;font-size:12px;color:var(--fg4);word-break:break-all;background:var(--chip);padding:6px 8px}
`

// One combined view: the ext-apps runtime (~400KB incl. protocol schema)
// would be duplicated per view otherwise. views/app.ts dispatches on the
// tool payload shape.
const VIEWS = [{ key: 'app', entry: 'views/app.ts', title: 'ClearList' }]

async function bundleView(entry) {
  const result = await build({
    entryPoints: [join(__dirname, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    write: false,
  })
  return result.outputFiles[0].text
}

const parts = []
for (const view of VIEWS) {
  const js = await bundleView(view.entry)
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${view.title}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div id="root">Loading…</div>
<script>${js}</script>
</body>
</html>`
  parts.push(`  ${view.key}: ${JSON.stringify(html)},`)
}

const out = `/**
 * AUTO-GENERATED by src/ui/build-ui.mjs — DO NOT EDIT BY HAND.
 * Regenerate after changing src/ui/views/*: npm run build:ui
 *
 * MCP Apps (SEP-1865) wiring: the ui:// view resource, self-contained
 * bundled HTML, and the registration helper. Committed so both the tsc
 * build (node stdio server) and the Next.js remote endpoint can import it
 * with no runtime fs read and no esbuild step.
 *
 * IMPORTANT: this module is value-imported by BOTH the node dist and the
 * Next.js bundler, so it must contain no relative value imports (type-only
 * imports are fine — they're erased before either resolver runs). The tool
 * _meta that references UI_APP_RESOURCE_URI lives as a literal in
 * seller-tools.ts for the same reason; keep the URI in sync.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Spec mime type for MCP App views (ext-apps RESOURCE_MIME_TYPE). */
export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

/** The single ClearList app view, shared by all UI-enabled tools. */
export const UI_APP_RESOURCE_URI = 'ui://clearlist/app.html'

const UI_VIEW_HTML: Record<'app', string> = {
${parts.join('\n')}
}

/** Register the ui:// view as an MCP resource on the given server. */
export function registerUiResources(server: McpServer): void {
  server.registerResource(
    'clearlist-ui-app',
    UI_APP_RESOURCE_URI,
    {
      title: 'ClearList app view',
      description:
        'Interactive view for ClearList tool results: listings gallery, publish success card, and reservations summary.',
      mimeType: UI_RESOURCE_MIME_TYPE,
      // MCP Apps sandboxes the view and default-denies external resources
      // (ext-apps schema: resourceDomains "omitted -> no network resources").
      //
      // DO NOT read this as "declaring these makes images work". It did not.
      // No view emits an <img> any more — see the docblock in views/listings.ts
      // for the observation and the leading hypothesis. The declaration is kept
      // because it is correct per spec and free on hosts that implement it, and
      // both storage hosts stay listed so a future image-bearing view does not
      // have to rediscover which origins ClearList photos come from:
      // agent-created listings serve bare storage.googleapis.com (Admin SDK
      // makePublic), PWA-created ones tokened firebasestorage.googleapis.com.
      _meta: {
        ui: {
          csp: {
            resourceDomains: [
              'https://storage.googleapis.com',
              'https://firebasestorage.googleapis.com',
            ],
          },
        },
      },
    },
    async () => ({
      // Mirror the CSP on the resources/read result too; hosts may read it from
      // either the registration metadata or the read response.
      _meta: {
        ui: {
          csp: {
            resourceDomains: [
              'https://storage.googleapis.com',
              'https://firebasestorage.googleapis.com',
            ],
          },
        },
      },
      contents: [
        {
          uri: UI_APP_RESOURCE_URI,
          mimeType: UI_RESOURCE_MIME_TYPE,
          text: UI_VIEW_HTML.app,
        },
      ],
    }),
  )
}
`
writeFileSync(join(__dirname, 'register.ts'), out)
process.stdout.write(`register.ts written (${VIEWS.length} views)\n`)
