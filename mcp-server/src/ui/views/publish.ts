/** publish_page renderer — success card with the shareable sale-page URL. */
import { esc } from './shared'

export interface PublishPayload {
  message?: string
  url?: string
  slug?: string
}

export function renderPublish(data: PublishPayload): string {
  // Defense in depth: the URL comes from our own API, but only ever link https.
  if (!data.url || !/^https:\/\//.test(data.url)) {
    return `<div class="empty">${esc(data.message ?? 'Page updated.')}</div>`
  }
  return `<div class="publish">
    <div class="check">✓</div>
    <div class="msg">${esc(data.message ?? 'Sale page published!')}</div>
    <a class="url" href="${esc(data.url)}" target="_blank" rel="noopener noreferrer">${esc(data.url)}</a>
    <div class="hint">Share this link — buyers browse and reserve without an account.</div>
  </div>`
}
