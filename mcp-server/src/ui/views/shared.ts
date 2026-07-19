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

export function formatPrice(price: unknown, isFree: unknown): string {
  if (isFree) return 'FREE'
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

/**
 * Wire a view: create the App, render every tool result into #root,
 * surface errors, and connect. `render` returns the inner HTML for a
 * successful, parsed payload.
 */
export function mountView<T>(name: string, render: (data: T) => string): void {
  const root = document.getElementById('root')
  if (!root) return

  const app = new App({ name, version: '0.4.0' })

  app.ontoolresult = (params: ToolResultParams) => {
    if (params.isError) {
      const message = params.content?.find((c) => c.type === 'text')?.text ?? 'Something went wrong.'
      root.innerHTML = `<div class="error">${esc(message)}</div>`
      return
    }
    const data = parseResult<T>(params)
    root.innerHTML = data ? render(data) : '<div class="error">No data received.</div>'
  }

  app.connect().catch(() => {
    root.innerHTML = '<div class="error">Could not connect to the host.</div>'
  })
}
