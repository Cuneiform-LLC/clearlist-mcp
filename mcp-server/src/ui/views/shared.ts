/**
 * Shared helpers for ClearList MCP App views.
 *
 * Views are bundled by src/ui/build-ui.mjs (esbuild) into self-contained
 * HTML served as ui:// resources — they are excluded from the server tsc
 * build because they target the browser, not node.
 */
import { App } from '@modelcontextprotocol/ext-apps'

/** Tool results arrive as MCP content blocks; ours carry one JSON text block. */
export interface ToolResultParams {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: unknown
}

export function parseResult<T>(params: ToolResultParams): T | null {
  if (params.structuredContent) return params.structuredContent as T
  const text = params.content?.find((c) => c.type === 'text')?.text
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The only safe way to put a URL into an `href` or `src` in these views.
 *
 * `esc()` is NOT sufficient on its own: it encodes markup characters, so it
 * stops an attacker closing the attribute, but `javascript:alert(1)` contains
 * none of those characters and survives escaping intact. A link built from
 * `href="${esc(url)}"` is therefore still an executable-URL sink.
 *
 * That matters because these URLs are not guaranteed first-party. The server
 * reads its API base from `CLEARLIST_API_URL` (index.ts), so a self-hosted or
 * misconfigured client can have every item URL come back from somewhere other
 * than clearlist.me — and the widget renders inside the seller's assistant.
 *
 * Returns null for anything that is not an https URL; callers render the text
 * unlinked rather than emitting a dangerous attribute.
 */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Parse rather than prefix-match. `https://`, `https://?x` and `https://#x`
  // all satisfy a `^https://` regex and none of them is a usable URL — they
  // reach href/src as broken links and images.
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 ? value : null
  } catch {
    return null
  }
}

export function formatPrice(price: unknown, isFree: unknown): string {
  if (isFree) return 'FREE'
  // null means "the stored price could not be read", NOT zero — and
  // `Number(null)` is 0, so this must be rejected BEFORE the coercion.
  // `publish/route.ts:31-35` sets null deliberately and says why: "NOT 0: `0`
  // means free, which is a real and common choice here, so defaulting corrupt
  // data to it would have the agent announce a $175 item as a giveaway with
  // nothing to distinguish the two." Coercing here reproduced in the widget the
  // exact bug the route went out of its way to avoid. Empty string coerces to 0
  // the same way.
  if (price === null || price === undefined || price === '') return '—'
  const n = Number(price)
  return Number.isFinite(n) ? `$${n.toLocaleString()}` : '—'
}

const STATUS_STYLES: Record<string, string> = {
  available: 'background:#DCFCE7;color:#166534',
  reserved: 'background:#FEF3C7;color:#A16207',
  taken: 'background:#FEE2E2;color:#991B1B',
  draft: 'background:#F3F4F6;color:#4B5563',
}

export function statusBadge(status: unknown): string {
  const s = String(status ?? 'draft')
  const style = STATUS_STYLES[s] ?? STATUS_STYLES.draft
  return `<span style="${style};padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;text-transform:capitalize">${esc(s)}</span>`
}

/** What an action handler is given to do its work. */
export interface ViewActions<T> {
  /**
   * Invoke a tool on our own server and report the outcome in plain terms.
   *
   * Never throws. A transport failure and a tool-level error arrive by
   * different routes in the ext-apps runtime (thrown vs `isError` on the
   * result), and a card that only handled one of them would sit on a spinner
   * forever in the other case.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }>
  /** Replace the card's contents, e.g. with a pending or finished state. */
  setHtml(html: string): void
  /** The payload the card was rendered from. */
  data: T
}

/**
 * Wire a view: create the App, render every tool result into #root, surface
 * errors, and connect. `render` returns the inner HTML for a successful,
 * parsed payload.
 *
 * `onAction` makes a card interactive. Any element the render function marks
 * with `data-action="..."` routes here on click, via one delegated listener on
 * #root rather than per-element handlers — the innerHTML is replaced on every
 * tool result, so handlers bound to individual nodes would be discarded with
 * the nodes and silently stop working after the first render.
 */
export function mountView<T>(
  name: string,
  render: (data: T) => string,
  onAction?: (action: string, actions: ViewActions<T>) => void | Promise<void>,
): void {
  const root = document.getElementById('root')
  if (!root) return

  const app = new App({ name, version: '0.9.18' })
  let current: T | null = null

  app.ontoolresult = (params: ToolResultParams) => {
    if (params.isError) {
      const message = params.content?.find((c) => c.type === 'text')?.text ?? 'Something went wrong.'
      root.innerHTML = `<div class="error">${esc(message)}</div>`
      return
    }
    const data = parseResult<T>(params)
    current = data
    root.innerHTML = data ? render(data) : '<div class="error">No data received.</div>'
  }

  if (onAction) {
    root.addEventListener('click', (event) => {
      const target = (event.target as Element | null)?.closest('[data-action]')
      if (!target || current === null) return

      const action = target.getAttribute('data-action')
      if (!action) return

      // Guard here rather than in each handler. Every action this supports is
      // irreversible, and a double click on a slow connection would otherwise
      // fire it twice before the first result came back.
      if (target.getAttribute('data-busy') === '1') return
      target.setAttribute('data-busy', '1')

      void onAction(action, {
        data: current,
        setHtml: (html: string) => {
          root.innerHTML = html
        },
        callTool: async (toolName, args) => {
          try {
            const result = await app.callServerTool({ name: toolName, arguments: args })
            const text =
              (result.content as Array<{ type: string; text?: string }> | undefined)?.find(
                (c) => c.type === 'text',
              )?.text ?? ''
            if (result.isError) {
              return { ok: false, message: text || 'That did not go through.' }
            }
            return { ok: true, message: text }
          } catch {
            // Thrown means the call never reached the server, so nothing
            // happened. Saying so matters here: the alternative reading is that
            // it might have worked, and a seller who assumes that stops waiting
            // for an address that never went.
            return { ok: false, message: 'Could not reach ClearList. Nothing was sent.' }
          }
        },
      })
    })
  }

  app.connect().catch(() => {
    root.innerHTML = '<div class="error">Could not connect to the host.</div>'
  })
}
