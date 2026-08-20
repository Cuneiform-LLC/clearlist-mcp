/**
 * Picks which card renders a tool result.
 *
 * One MCP App bundle serves four tools, so the payload shape is the only
 * signal available — the host hands the view a tool RESULT, not the tool name.
 *
 * This lived inside `app.ts` as a module-local function until 2026-08-19,
 * where no test could reach it: `app.ts` calls `mountView()` at import, which
 * needs a DOM and the ext-apps runtime, so importing the module to test the
 * dispatch would execute the mount. It shipped a bug that a single test would
 * have caught — the first guard was `'items' in data`, and `publish_page`
 * returns `items[]`, so every publish rendered as a listings grid with
 * "undefined listings" (no `total` field) and grey placeholders (no
 * `photo_url`), while this file's publish card never drew at all.
 *
 * Two rules follow from that:
 *
 * 1. **Every guard is specific enough to be mutually exclusive.** `items[]`
 *    alone is not a signal — two tools return it. `total` + `items[]` is
 *    (get_listings has both, publish_page has neither `total` nor any other
 *    tool's marker).
 * 2. **Ambiguity renders nothing rather than guessing.** If zero or more than
 *    one guard matches, this returns the `unknown` kind and the neutral card.
 *    An ordered if-chain silently resolves ambiguity by position, which is
 *    what shipped the original bug; a future payload gaining a second marker
 *    should surface as a plain message, not as a confidently wrong card.
 */
import { renderListings, type ListingsPayload } from './listings'
import { renderPublish, type PublishPayload } from './publish'
import { renderReservations, type ReservationsPayload } from './reservations'
import { renderUploadSession, type UploadSessionPayload } from './upload-session'
import { renderAddressConfirm, type AddressConfirmPayload } from './address-confirm'
import { esc } from './shared'

export type ViewKind =
  | 'listings'
  | 'publish'
  | 'reservations'
  | 'upload-session'
  | 'address-confirm'
  | 'unknown'

export type AnyPayload =
  | ListingsPayload
  | PublishPayload
  | ReservationsPayload
  | UploadSessionPayload
  | AddressConfirmPayload

function has(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key)
}

/**
 * Each guard names the field combination unique to ONE tool's response.
 * Deliberately not ordered — `selectView` requires exactly one match.
 */
const GUARDS: ReadonlyArray<{ kind: Exclude<ViewKind, 'unknown'>; match: (d: Record<string, unknown>) => boolean }> = [
  {
    kind: 'reservations',
    match: (d) => Array.isArray(d.reservations),
  },
  {
    // The raw upload token never appears in the payload; `session_id` is the
    // hash, and it is unique to this tool.
    kind: 'upload-session',
    match: (d) => typeof d.session_id === 'string',
  },
  {
    // `items[]` alone is NOT enough — publish_page returns one too.
    kind: 'listings',
    match: (d) => Array.isArray(d.items) && typeof d.total === 'number',
  },
  {
    // publish_page always sends `slug`; no other tool in this bundle does.
    kind: 'publish',
    match: (d) => typeof d.slug === 'string' && has(d, 'url'),
  },
  {
    // share_address. Both fields, not just `confirmation_token`: the flag is
    // what says this payload is a QUESTION rather than a report, and the token
    // is what makes it actionable. A payload carrying one without the other is
    // not this card and should fall through to the neutral one.
    kind: 'address-confirm',
    match: (d) => d.awaiting_confirmation === true && typeof d.confirmation_token === 'string',
  },
]

export function selectView(data: unknown): ViewKind {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'unknown'
  const record = data as Record<string, unknown>
  const matched = GUARDS.filter((g) => g.match(record))
  // Exactly one, or nothing. Two matches means the shapes have converged and a
  // human needs to re-derive the guards — rendering either one would be a
  // coin flip presented to the seller as fact.
  return matched.length === 1 ? matched[0].kind : 'unknown'
}

/**
 * The neutral card. Shows the payload's own `message` when it has one, so a
 * tool whose shape we do not recognise still tells the seller what happened.
 */
function renderUnknown(data: unknown): string {
  const message =
    data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
      ? (data as { message: string }).message
      : 'Done.'
  return `<div class="empty">${esc(message)}</div>`
}

export function renderPayload(data: AnyPayload): string {
  switch (selectView(data)) {
    case 'listings':
      return renderListings(data as ListingsPayload)
    case 'reservations':
      return renderReservations(data as ReservationsPayload)
    case 'upload-session':
      return renderUploadSession(data as UploadSessionPayload)
    case 'publish':
      return renderPublish(data as PublishPayload)
    case 'address-confirm':
      return renderAddressConfirm(data as AddressConfirmPayload)
    default:
      return renderUnknown(data)
  }
}
