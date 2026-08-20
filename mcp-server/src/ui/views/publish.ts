/**
 * publish_page renderer — the seller's shareable sale-page card.
 *
 * This view was unreachable for its own tool until 2026-08-19: the dispatcher
 * routed any payload carrying `items[]` to the listings grid, and publish_page
 * returns `items[]`, so a publish rendered as a broken gallery ("undefined
 * listings", grey photo placeholders) and this card never drew. See
 * `dispatch.ts` for the fix.
 *
 * It renders publish's OWN roster shape — title, price, status, link — not the
 * listings one. publish_page sends no photos, so a photo-shaped card is wrong
 * here by construction.
 *
 * The card must not overstate. A publish can succeed while the page is NOT
 * live — republishing a page whose expiry lapsed returns `page_live: false`
 * with null item URLs — and a green check over that tells the seller their
 * sale is up when buyers are seeing "This sale has ended".
 *
 * The check is suppressed for liveness ONLY. A refused `custom_url` or
 * `payment_instructions` on a live page is still a real publication, so it
 * keeps the check and carries the server's refusal message beneath it. An
 * earlier version of this comment claimed both suppressed the check, which the
 * code has never done.
 */
import { esc, formatPrice, statusBadge, safeHttpsUrl } from './shared'

export interface PublishItem {
  item_id?: string
  title?: string
  /** null = the stored price could not be read. NOT zero. See formatPrice. */
  price?: number | null
  status?: string
  public_url?: string | null
}

export interface PublishPayload {
  message?: string
  url?: string
  slug?: string
  page_live?: boolean
  items?: PublishItem[]
  _warnings?: string[]
  payment_instructions_applied?: boolean
  payment_instructions_message?: string
  custom_url_applied?: boolean
  custom_url_message?: string
}

/** A setting the publish refused: relay the server's own message, not our gloss. */
function refusal(applied: boolean | undefined, message: string | undefined): string {
  if (applied !== false || !message) return ''
  return `<div class="hint">⚠ ${esc(message)}</div>`
}

function roster(items: PublishItem[] | undefined, pageIsLive: boolean): string {
  // `items: []` and an ABSENT `items` mean different things and must not
  // collapse together. The route sends an empty array to say "the publish
  // succeeded and there are zero listings" — a page a buyer opens to nothing —
  // and omits the key entirely when the roster lookup failed (paired with a
  // roster_failed warning) or on the rename branch, which has no roster.
  if (items === undefined) return ''
  if (items.length === 0) {
    // Both conditions co-occur on a real payload: republishing onto a lapsed
    // page with zero available items sends `page_live: false` AND `items: []`.
    // Saying "buyers see an empty sale" beside "buyers see: this sale has
    // ended" is one card contradicting itself about the same visitor, so the
    // wording describes the PAGE's contents unless the page is actually live.
    return pageIsLive
      ? '<div class="hint">This page has no items on it yet, so buyers opening the link see an empty sale.</div>'
      : '<div class="hint">There are no items on this page.</div>'
  }
  const rows = items
    .map((item) => {
      // Same https policy as the page URL below. `esc()` stops an attacker
      // closing the attribute but leaves `javascript:` intact, so escaping
      // alone does not make a URL safe to put in an href — and these come
      // from whatever CLEARLIST_API_URL points at.
      const href = safeHttpsUrl(item.public_url)
      const title = href
        ? `<a class="url" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
        : esc(item.title)
      return `<div class="res">
        <div class="row"><span class="price">${formatPrice(item.price, false)}</span>${statusBadge(item.status)}</div>
        <div class="items">${title}</div>
      </div>`
    })
    .join('')
  // "on the page" is a claim about what buyers can reach. On a not-live page
  // every public_url is null and the page 404s, so that header sat directly
  // under "This page has expired" — the third instance of this overstatement
  // class in one change. The count is still worth showing; the framing is not.
  const header = pageIsLive
    ? `${items.length} item${items.length === 1 ? '' : 's'} on the page`
    : `${items.length} item${items.length === 1 ? '' : 's'} in this sale`
  return `<div class="head">${header}</div>${rows}`
}

export function renderPublish(data: PublishPayload): string {
  // Defense in depth: only ever LINK https. But a non-https URL must not
  // short-circuit the whole card — an earlier version returned the bare
  // message here and silently dropped page_live: false, the setting refusals,
  // roster_failed and the roster with it. `buildPageUrl` trusts
  // NEXT_PUBLIC_BASE_URL, so `http://localhost` is a real configuration, and
  // that is exactly when a seller most needs the warnings.
  const pageUrl = safeHttpsUrl(data.url)
  const link = pageUrl
    ? `<a class="url" href="${esc(pageUrl)}" target="_blank" rel="noopener noreferrer">${esc(pageUrl)}</a>`
    : data.url
      ? `<div class="hint">Page URL: ${esc(data.url)} (not shown as a link — it is not https)</div>`
      : ''

  const settings =
    refusal(data.payment_instructions_applied, data.payment_instructions_message) +
    refusal(data.custom_url_applied, data.custom_url_message)

  // `roster_failed` means the item list could not be read. It says nothing
  // about whether the PAGE is live, so the wording must not — an expired
  // republish can carry this warning too, and "the page itself is fine" beside
  // "this page has expired" is a card contradicting itself.
  const rosterFailed = data._warnings?.includes('roster_failed')
    ? '<div class="hint">⚠ Could not read the item list, so no items are shown below. Try get_listings.</div>'
    : ''

  const tail = `${settings}${rosterFailed}\n      ${roster(data.items, data.page_live === true)}`

  if (data.page_live === false) {
    return `<div class="publish">
      <div class="msg">${esc(data.message ?? 'Published, but the page is not live.')}</div>
      <div class="hint">This page has expired, so buyers opening the link see "This sale has ended". Use extend_sale_page to bring it back.</div>
      ${link}
      ${tail}
    </div>`
  }

  // The check requires an explicit TRUE, not merely "not false". publish_page
  // has a third branch — the custom-URL rename at `publish/route.ts:587` — that
  // returns slug and url and NO page_live, and it deliberately writes no
  // `page_published`, so the page can still be offline. An earlier version of
  // this file assumed absence meant "old response" and drew the check anyway,
  // which is the overstatement this whole card exists to prevent.
  //
  // The headline is OURS here, not `data.message`. The tool sets that to "Sale
  // page published!" for anything except an explicit `page_live: false`
  // (seller-tools.ts), so echoing it would put a publication claim directly
  // above the warning that says we cannot confirm one.
  if (data.page_live !== true) {
    return `<div class="publish">
      <div class="msg">Page settings updated.</div>
      ${link}
      <div class="hint">This response did not report whether the page is live, so do not tell the seller buyers can see it yet — check get_listings or check_tier_status first.</div>
      ${tail}
    </div>`
  }

  // "Share this link" only when there IS a link. With a non-https base URL the
  // anchor is suppressed above, and an invitation to share a link that is not
  // rendered reads as a broken card.
  const shareHint = pageUrl
    ? '<div class="hint">Share this link — buyers browse and reserve without an account.</div>'
    : ''
  return `<div class="publish">
    <div class="check">✓</div>
    <div class="msg">${esc(data.message ?? 'Sale page published!')}</div>
    ${link}
    ${shareHint}
    ${tail}
  </div>`
}
