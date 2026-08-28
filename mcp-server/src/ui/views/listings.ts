/**
 * get_listings renderer — status list with price, state and a public link.
 *
 * NO PHOTOS, DELIBERATELY — do not "fix" this by adding an <img> back.
 *
 * OBSERVED 2026-08-27: storage URLs render as broken-image glyphs in claude.ai
 * despite the `csp.resourceDomains` we declare on the ui:// resource, and a
 * local reproduction under the sandbox's own response header
 * (`img-src 'self' data: blob:`, read off the wire) refuses a
 * storage.googleapis.com image with a CSP violation naming that directive while
 * a `data:` image in the same frame renders.
 *
 * BEST EXPLANATION, not a verified fact: the sandbox proxy drops our
 * declaration. Reading its script found no `csp` handling and an inner frame
 * built with document.write, which inherits the parent policy. Absence of a
 * string in one bundle is not proof, so treat the mechanism as the leading
 * hypothesis and the broken glyphs as the evidence.
 *
 * RE-CHECK TRIGGER: if photos ever render in this card again, this whole block
 * is stale. Nothing in CI can notice that for us.
 *
 * Inlining bytes is the only thing that CAN render, and it would put image data
 * in the seller's context window on every call, growing with their inventory,
 * for a view where the seller already knows what their own things look like.
 * What they do NOT know at a glance is what is still unsold and who is waiting,
 * so the strip carries that instead. The photos stay one click away behind each
 * item's public link.
 */
import { esc, formatPrice, safeHttpsUrl } from './shared'

interface Listing {
  item_id?: string
  title?: string
  price?: number
  final_price?: number | null
  is_free?: boolean
  status?: string
  condition?: string
  category?: string
  queue_count?: number
  photo_url?: string | null
  photos?: number
  public_url?: string | null
  requires_truck?: boolean
}

export interface ListingsPayload {
  total: number
  items: Listing[]
  page_url?: string | null
  page_live?: boolean
  _warnings?: string[]
}

/** Status dot colours. Grey is draft's own colour AND the unknown fallback. */
const DOT: Record<string, string> = {
  available: '#059669',
  reserved: '#F59E0B',
  taken: '#DC2626',
  draft: '#9CA3AF',
}

/**
 * Own-property lookup, NOT `DOT[status] ?? DOT.draft`.
 *
 * `DOT` is an object literal, so inherited keys resolve and are truthy: a
 * status of `constructor` or `toString` returns a function's source text and
 * `??` never fires, putting a raw server string into a `style` attribute. The
 * status is as server-controlled as public_url is.
 */
function dotColour(status: string): string {
  return Object.prototype.hasOwnProperty.call(DOT, status) ? DOT[status] : DOT.draft
}

/**
 * The price to count, or null when it cannot be read.
 *
 * ONE predicate, shared with the rows, because a summary that counts what a row
 * refuses to print is how the strip and the list end up disagreeing. It rejects
 * exactly what formatPrice() rejects, and rejects it BEFORE any coercion:
 * `Number(null)`, `Number('')`, `Number([])` and `Number(' ')` are all 0, and
 * `Number([500])` is 500, so a bare `Number()` would invent money out of
 * malformed data. `is_free` is compared strictly because the string "false" is
 * truthy and would silently drop a priced item out of the total.
 */
function countablePrice(item: Listing): number | null {
  if (item.is_free === true) return null
  // `unknown`, not the declared `number`. This payload is parsed JSON from a
  // configurable API, so the declared type is a hope, not a guarantee, and the
  // whole point of this function is the values that violate it.
  const raw: unknown = item.price
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Available first — the part of the list a seller is acting on. */
function byInterest(items: Listing[]): Listing[] {
  return [
    ...items.filter((i) => i.status === 'available'),
    ...items.filter((i) => i.status !== 'available'),
  ]
}

function summary(items: Listing[]): string {
  const available = items.filter((i) => i.status === 'available')

  // Count what could not be counted. A total that silently omits items is the
  // number a seller uses to decide whether the sale is worth another weekend,
  // and it goes quietly LOW with nothing on screen to say so.
  let uncounted = 0
  let unsold = 0
  for (const item of available) {
    if (item.is_free === true) continue
    const price = countablePrice(item)
    if (price === null) {
      uncounted++
      continue
    }
    unsold += price
  }

  const queued = items.reduce((sum, i) => {
    const n = Number(i.queue_count)
    return Number.isFinite(n) && n > 0 ? sum + n : sum
  }, 0)

  const cell = (value: string, label: string) => `<div><b>${esc(value)}</b>${esc(label)}</div>`
  return `<div class="ls-sum">
    ${cell(String(items.length), `listing${items.length === 1 ? '' : 's'}`)}
    ${cell(String(available.length), 'available')}
    ${cell(
      `$${Math.round(unsold).toLocaleString()}`,
      uncounted ? `unsold (${uncounted} without a price)` : 'unsold',
    )}
    ${cell(String(queued), `buyer${queued === 1 ? '' : 's'} queued`)}
  </div>`
}

function row(item: Listing): string {
  const status = String(item.status ?? 'draft')
  const title = esc(item.title ?? 'Untitled item')

  // https-only via safeHttpsUrl (see its docblock in shared.ts for why esc()
  // alone is not enough for a URL sink).
  //
  // A null public_url has TWO causes and only one of them is "not public": the
  // route also nulls every URL when the page-context read fails. renderListings
  // separates them off `_warnings`, so unlinked-here is honest only because the
  // warning case is handled there. Do not read this branch as "buyers cannot
  // see it" on its own.
  //
  // target/rel match the sibling views (publish.ts, upload-session.ts). Without
  // them the link either does nothing inside the sandbox frame, or replaces the
  // card with an arbitrary https origin rendered inside the assistant's chrome
  // with no address bar to disambiguate it.
  const href = safeHttpsUrl(item.public_url)
  const name = href
    ? `<a class="ls-a" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : title

  // A sold item's asking price is not what it sold for. The payload carries
  // final_price precisely so the seller can see the difference; showing `price`
  // for a taken item reports a number the seller did not receive.
  const sold =
    item.final_price === null || item.final_price === undefined
      ? null
      : countablePrice({ price: item.final_price })
  const shown =
    status !== 'available' && sold !== null
      ? `$${sold.toLocaleString()}`
      : formatPrice(item.price, item.is_free)

  const bits: string[] = []
  // Two conditions, both load-bearing. `item.status &&`: printing the word
  // "draft" for a payload that carried no status asserts a state the server
  // never claimed. `!== 'available'`: available is the norm and the green dot
  // already says it, so repeating it is noise on most rows.
  //
  // Note this only silences the WORD. dotColour() still falls back to draft's
  // own grey, so an unknown status and a real draft look identical in the dot.
  if (item.status && status !== 'available') bits.push(esc(status))
  if (item.condition) bits.push(esc(item.condition))
  if (item.category) bits.push(esc(item.category))
  if (Number(item.photos) > 1) bits.push(`${esc(item.photos)} photos`)
  if (item.requires_truck) bits.push('needs a truck')

  const queuedRaw = Number(item.queue_count)
  const queued = Number.isFinite(queuedRaw) && queuedRaw > 0 ? queuedRaw : 0
  const queue = queued ? `<span class="ls-q">${esc(queued)} in queue</span>` : ''

  return `<div class="ls-row">
    <span class="ls-dot" style="background:${esc(dotColour(status))}"></span>
    <span class="ls-p">${shown}</span>
    <span class="ls-t">${name}</span>
    ${queue}
    <span class="ls-m">${bits.join(' · ')}</span>
  </div>`
}

export function renderListings(data: ListingsPayload): string {
  if (!data.items?.length) {
    return '<div class="empty">No listings yet. Photograph an item to create the first one.</div>'
  }
  const rows = byInterest(data.items).map(row).join('')

  /**
   * `page_context_failed` means OUR page-settings read failed, and the route
   * responds by nulling every public_url and OMITTING page_live rather than
   * claiming `false` — its own comment says a consumer reporting the sale
   * offline during our outage is the thing to avoid. Rendering the resulting
   * payload plainly produces a card pixel-identical to a seller who never
   * published: no link on any row, no sale-page link. Say what actually
   * happened instead.
   */
  const contextFailed = data._warnings?.includes('page_context_failed') === true

  const page = safeHttpsUrl(data.page_url)
  // `!== false`, NOT `=== true`. page_live is a TRI-state: true, false, or
  // omitted when the route could not determine it. `false` is an affirmative
  // "buyers see this sale has ended", and hiding the link there is right.
  // Omitted is "unknown", and treating unknown as dead would hide a working
  // link during our own outage. Do not tidy this to `=== true`.
  const footer = contextFailed
    ? `<div class="ls-note">We could not read your page settings just now, so the links are missing here. That is on our side, not your sale. Ask again in a moment.</div>`
    : page && data.page_live !== false
      ? `<div class="ls-foot"><a class="ls-a" href="${esc(page)}" target="_blank" rel="noopener noreferrer">Open your sale page</a></div>`
      : ''

  // One panel with its own surface, like the cards it replaces. `body` is
  // transparent, so rows sitting straight on the host's background depend on it
  // for contrast and go unreadable whenever it is close to the text colour.
  return `<div class="ls-panel">${summary(data.items)}<div class="ls-list">${rows}</div>${footer}</div>`
}
