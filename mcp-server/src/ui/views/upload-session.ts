/**
 * `create_upload_session` renderer — the QR handoff card.
 *
 * This is the one view whose whole reason to exist is a picture. The seller is
 * reading this on a laptop and the photos are on their phone, so the useful
 * thing is a code they can point that phone at. A URL in chat text cannot be
 * scanned, and retyping 64 hex characters is not a flow anyone completes.
 *
 * ── Why the QR is drawn here and not fetched ──
 *
 * The token rides in the URL fragment (after `#`) precisely so it never reaches
 * a server. Asking any endpoint — ours included — to render the QR would put the
 * live upload credential in a request, undoing that. So the matrix is computed
 * in the browser from the URL the card was already handed, and nothing leaves
 * the host.
 *
 * The encoder is bundled at BUILD time (esbuild inlines it into the ui://
 * resource, same as the ext-apps runtime), so it is a devDependency and adds
 * nothing to what `npm i @clearlist/mcp-server` installs.
 */
import qrcode from 'qrcode-generator'
import { esc } from './shared'

export interface UploadSessionPayload {
  session_id?: string
  url?: string
  expires_at?: string
  max_photos?: number
  remaining_items?: number | null
  relay_message?: string
}

/**
 * QR as inline SVG paths.
 *
 * Type 0 lets the encoder pick the smallest version that fits, and 'M' error
 * correction is the usual default — a phone camera reads it comfortably at this
 * size, and it survives a little glare on a screen.
 *
 * Drawn as one `<path>` of rectangles rather than one element per module: a
 * version-6 code is ~1,700 modules, and that many DOM nodes is visibly slow to
 * paint inside a chat transcript.
 */
function qrSvg(value: string, sizePx: number): string {
  const qr = qrcode(0, 'M')
  qr.addData(value)
  qr.make()

  const count = qr.getModuleCount()
  // One quiet-zone module either side. The spec asks for four; two reads fine on
  // a screen and keeps the code larger at the same footprint.
  const quiet = 2
  const total = count + quiet * 2

  let d = ''
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        d += `M${col + quiet} ${row + quiet}h1v1h-1z`
      }
    }
  }

  return (
    `<svg viewBox="0 0 ${total} ${total}" width="${sizePx}" height="${sizePx}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code for the upload link" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${d}" fill="#1c1c1a"/>` +
    `</svg>`
  )
}

/** "expires 3:42 PM" — the host's locale, not ours. */
function expiryLine(expiresAt: string | undefined): string {
  if (!expiresAt) return ''
  const when = new Date(expiresAt)
  if (Number.isNaN(when.getTime())) return ''
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Open it before ${esc(time)}.`
}

/**
 * Is this a link WE produced?
 *
 * A QR is an instruction to point a camera at something, so the bar is higher
 * than for a text link: whatever this encodes, the seller will follow without
 * reading it. It must be our host, our path, and a token of the right shape.
 *
 * Parsed rather than regexed, because the first version of this check was
 * `/^https:\/\/[^\s]+\/u#[0-9a-f]{64}$/` and `[^\s]+` happily matched
 * `evil.example/u#<64 hex>` — it pinned the shape and not the destination, which
 * is the one thing that actually mattered. Its own test caught it.
 */
/**
 * Exactly the hosts we serve `/u` from. An ALLOWLIST, not a suffix match.
 *
 * `host.endsWith('.clearlist.me')` was broader than this guard's own threat
 * model. The whole premise is that a QR is followed without being read, so the
 * destination has to be pinned rather than pattern-matched: one stale DNS record
 * on an unclaimed subdomain, or any future wildcard, and the suffix test hands a
 * scannable code to somewhere nobody vetted.
 */
const ALLOWED_HOSTS = new Set(['clearlist.me', 'www.clearlist.me', 'localhost'])

function isOwnSessionUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  const host = u.hostname
  if (!ALLOWED_HOSTS.has(host)) return false

  // Protocol is checked AFTER the host, and localhost is the one exception.
  // Checking `https:` first made the documented dev allowance dead code: a local
  // server runs on `http://localhost:3000`, so every dev URL was rejected and the
  // card fell back for the one case the allowance existed to serve.
  const httpsOnly = host !== 'localhost'
  if (httpsOnly && u.protocol !== 'https:') return false
  if (!httpsOnly && u.protocol !== 'http:' && u.protocol !== 'https:') return false

  if (u.pathname !== '/u') return false
  return /^#[0-9a-f]{64}$/.test(u.hash)
}

export function renderUploadSession(data: UploadSessionPayload): string {
  // Only ever render a CODE for a link we produced. Anything else must not
  // become something scannable pointing somewhere unexpected.
  const url = typeof data.url === 'string' ? data.url : ''
  if (!isOwnSessionUrl(url)) {
    // But the seller still needs a way through.
    //
    // This branch used to render `relay_message` alone, which `buildRelayMessage`
    // composes from the LIMITS and never the link — so the card said "Open this
    // link on your phone" with nothing to open. Worse, a Vercel preview
    // deployment is itself a rejected host, so testing this feature on a preview
    // showed exactly that dead end. The PR description claimed a fallback link
    // was rendered; it was not.
    //
    // The URL goes back as escaped TEXT, not a link and not a code. That keeps
    // the safe direction the guard exists for — a human reads the host before
    // acting on it, which is the one thing scanning a QR skips — while making
    // the card usable instead of a cul-de-sac.
    // The wording names NO cause. `isOwnSessionUrl` rejects for four different
    // reasons — host, protocol, path, token shape — and the first draft asserted
    // the host. A rejected `http://clearlist.me/u#<64 hex>` has an allowed host
    // and a wrong scheme, so that copy told the seller to look in the wrong
    // place. "Didn't pass the check" is true of every rejection path.
    const message = esc(data.relay_message ?? 'Upload link created.')
    if (!url) return `<div class="empty">${message}</div>`
    return `<div class="empty">
      <div>${message}</div>
      <div class="us-unverified">This link did not pass the ClearList check, so no scan code is shown.
      Check it before opening:</div>
      <code class="us-rawurl">${esc(url)}</code>
    </div>`
  }

  /**
   * A count: whole, non-negative, and within safe-integer range.
   *
   * `Number.isFinite` was the first hardening and it still admitted negatives
   * and fractions, so "about -3 more items" and "about 2.5 more items" both
   * rendered. That is the same garbage family the NaN fix addressed, and the
   * same one `get_profile`'s `isCount` was narrowed through four times on #535.
   * `parseResult` hands `structuredContent` straight through with no JSON
   * round-trip, so nothing upstream filters any of it.
   *
   * `isSafeInteger` rather than `isInteger`: it implies finite AND whole AND
   * bounded, which is every property a count needs, in one call.
   */
  const isCount = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

  // `null` is the ONLY "no value" signal, and the render checks `!== null`
  // rather than truthiness. Both counts run through the same `isCount`, which
  // accepts zero — so a truthiness test made the two disagree about whether zero
  // is information: `remaining_items: 0` rendered "0 more items" (deliberately,
  // it means the plan is full) while `max_photos: 0` vanished as though the
  // field had never been sent.
  const photos = isCount(data.max_photos) ? data.max_photos : null
  const remaining = data.remaining_items
  const capacity = isCount(remaining)
    ? `Your plan covers about ${remaining === 1 ? '1 more item' : `${remaining} more items`}.`
    : ''

  return `<div class="upload-session">
    <div class="us-title">Scan this with your phone</div>
    <div class="us-qr">${qrSvg(url, 190)}</div>
    <div class="us-sub">Photograph everything. Say <b>done</b> here when you have finished and I will build the listings.</div>
    <div class="us-why">Why your phone? Your assistant can look at a photo without being able to pass us the actual file. Sending straight from your phone gets us one we can read.</div>
    <div class="us-meta">
      ${photos !== null ? `<span>Up to ${photos} ${photos === 1 ? 'photo' : 'photos'}.</span>` : ''}
      <span>${expiryLine(data.expires_at)}</span>
      ${capacity ? `<span>${esc(capacity)}</span>` : ''}
    </div>
    <details class="us-fallback">
      <summary>No camera? Open the link instead</summary>
      <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>
    </details>
  </div>`
}
