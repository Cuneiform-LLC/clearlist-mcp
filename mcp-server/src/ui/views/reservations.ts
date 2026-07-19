/** get_reservations renderer — buyer reservations and conversation summary. */
import { esc } from './shared'

interface ReservationInfo {
  status?: string
  item_ids?: string[]
  expires_at?: string
  // Field names match src/types/reservation.ts ScheduledPickup.
  scheduled_pickup?: { slot_date?: string; slot_start?: string; slot_end?: string } | null
}

interface Conversation {
  conversation_id?: string
  buyer_email?: string
  buyer_name?: string
  unread_messages?: number
  last_message?: string
  first_item_title?: string
  item_count?: number
  reservation?: ReservationInfo | null
}

export interface ReservationsPayload {
  total: number
  reservations: Conversation[]
}

/** "IKEA Ektorp Sofa" / "IKEA Ektorp Sofa +2 more" from the API's display fields. */
function itemSummary(conv: Conversation): string {
  if (!conv.first_item_title) return ''
  const extra = (conv.item_count ?? 1) - 1
  return esc(conv.first_item_title) + (extra > 0 ? ` +${extra} more` : '')
}

export function renderReservations(data: ReservationsPayload): string {
  if (!data.reservations?.length) {
    return '<div class="empty">No reservations yet.</div>'
  }
  const rows = data.reservations
    .map((conv) => {
      const buyer = conv.buyer_name || conv.buyer_email || 'Buyer'
      const unread = conv.unread_messages
        ? `<span class="unread">${esc(conv.unread_messages)}</span>`
        : ''
      const items = itemSummary(conv)
      const pickup = conv.reservation?.scheduled_pickup
        ? `<div class="pickup">Pickup: ${esc(conv.reservation.scheduled_pickup.slot_date ?? '')} ${esc(conv.reservation.scheduled_pickup.slot_start ?? '')}</div>`
        : ''
      return `<div class="res">
        <div class="row"><span class="buyer">${esc(buyer)}${unread}</span></div>
        ${items ? `<div class="items">${items}</div>` : ''}
        ${conv.last_message ? `<div class="last">"${esc(conv.last_message)}"</div>` : ''}
        ${pickup}
      </div>`
    })
    .join('')
  return `<div class="head">${data.total} reservation${data.total === 1 ? '' : 's'}</div>${rows}`
}
