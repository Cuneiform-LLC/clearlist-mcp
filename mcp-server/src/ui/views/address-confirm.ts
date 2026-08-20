import { esc } from './shared'

/**
 * The confirmation card for sharing a seller's address.
 *
 * This card exists for one reason the host cannot cover. A host's own
 * tool-approval prompt says a tool wants to run; it cannot say WHO the address
 * is about to reach. That is the only fact that makes the decision, and the one
 * a seller cannot check from inside their assistant's transcript without
 * trusting the model's summary of it. So the recipient's name and email are the
 * loudest thing here, above the address itself.
 *
 * Being honest about what this is and is not: the Approve click is a better
 * decision surface, not a security boundary. The server sees the same API key
 * whether a human clicked or the model called the tool directly, so this card
 * cannot be the thing that stops an unattended share. The controls that do that
 * live server-side (conversation scoping, single use, expiry, and the email the
 * seller gets every time). See confirmation-token.ts.
 */
export interface AddressConfirmPayload {
  recipient?: { name?: unknown; email?: unknown }
  address?: unknown
  address_source?: unknown
  confirmation_token?: unknown
  conversation_id?: unknown
  awaiting_confirmation?: unknown
  expires_at?: unknown
}

const BTN_PRIMARY =
  'display:inline-block;background:#2C64E3;color:#fff;border:0;padding:10px 18px;' +
  'font-size:14px;font-weight:600;cursor:pointer;font-family:inherit'

export function renderAddressConfirm(data: AddressConfirmPayload): string {
  const name = String(data.recipient?.name ?? '').trim()
  const email = String(data.recipient?.email ?? '').trim()
  const address = String(data.address ?? '').trim()

  // Without a recipient there is nothing to decide on, and a card that renders
  // "Send your address to  ()" invites a click on an unknown. Refuse to draw
  // the button rather than draw an uninformative one.
  if (!name || !address) {
    return `<div class="error">Could not read who this address would go to. Nothing has been shared. Ask again to retry.</div>`
  }

  const fromAccount = data.address_source === 'account'

  return `
    <div class="head">Share your address?</div>
    <div class="card" style="padding:14px">
      <div style="font-size:13px;color:#6B7280;margin-bottom:4px">This will be sent to</div>
      <div style="font-size:17px;font-weight:700;color:#1F2937">${esc(name)}</div>
      ${email ? `<div style="font-size:14px;color:#4B5563;margin-top:2px">${esc(email)}</div>` : ''}

      <div style="border-top:1px solid #E5E7EB;margin:14px 0 0;padding:14px 0 0">
        <div style="font-size:13px;color:#6B7280;margin-bottom:4px">
          They will receive${fromAccount ? '' : ' (this one time)'}
        </div>
        <div style="font-size:15px;color:#1F2937;line-height:1.5">${esc(address)}</div>
      </div>

      <div style="margin-top:16px">
        <button type="button" data-action="approve" style="${BTN_PRIMARY}">
          Send my address
        </button>
      </div>

      <div style="font-size:12px;color:#6B7280;margin-top:12px;line-height:1.5">
        An address cannot be unsent. We will email you a record of this.
      </div>
    </div>
  `
}

/** Shown while the confirm call is in flight. */
export function renderAddressSending(name: string): string {
  return `
    <div class="head">Sharing your address</div>
    <div class="card" style="padding:14px">
      <div style="font-size:15px;color:#1F2937">Sending to ${esc(name)}...</div>
    </div>
  `
}

/**
 * The outcome. `message` comes back from the server, so it is escaped here even
 * though we author it: this string reaches innerHTML, and "we control it today"
 * is exactly the assumption that stops being true after one refactor.
 */
export function renderAddressResult(ok: boolean, name: string, message: string): string {
  if (!ok) {
    // The headline says what THIS attempt did, and nothing about the address's
    // history. It used to read "Your address was not sent." directly above the
    // server's message — which on a spent token says the opposite ("The address
    // was shared once"), because a retry after a lost response lands here. A
    // card that contradicts the sentence beneath it teaches a seller to
    // disbelieve the card.
    return `
      <div class="head">Not sent just now</div>
      <div class="card" style="padding:14px">
        <div style="font-size:15px;color:#DC2626;line-height:1.5">${esc(message)}</div>
        <div style="font-size:13px;color:#6B7280;margin-top:8px">Nothing went out from this attempt. Read the message above for what it means.</div>
      </div>
    `
  }
  return `
    <div class="head">Address shared</div>
    <div class="card" style="padding:14px">
      <div style="font-size:15px;color:#166534;font-weight:600">Sent to ${esc(name)}</div>
      <div style="font-size:13px;color:#6B7280;margin-top:6px;line-height:1.5">
        They have it in their reservation and by email. A record is on its way to your inbox.
      </div>
    </div>
  `
}
