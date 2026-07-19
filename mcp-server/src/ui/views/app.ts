/**
 * Single MCP App view shared by get_listings, publish_page, and
 * get_reservations. One bundle instead of three because the ext-apps
 * runtime (~400KB with the protocol schema) would otherwise be inlined
 * per view. The renderer is picked by payload shape — the three tools
 * return structurally distinct JSON.
 */
import { mountView } from './shared'
import { renderListings, type ListingsPayload } from './listings'
import { renderPublish, type PublishPayload } from './publish'
import { renderReservations, type ReservationsPayload } from './reservations'

type AnyPayload = ListingsPayload | PublishPayload | ReservationsPayload

function render(data: AnyPayload): string {
  if ('items' in data && Array.isArray(data.items)) {
    return renderListings(data)
  }
  if ('reservations' in data && Array.isArray(data.reservations)) {
    return renderReservations(data)
  }
  return renderPublish(data as PublishPayload)
}

mountView<AnyPayload>('ClearList', render)
