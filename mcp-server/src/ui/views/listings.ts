/** get_listings renderer — item gallery with photo, price, status. */
import { esc, formatPrice, statusBadge } from './shared'

interface Listing {
  item_id?: string
  title?: string
  price?: number
  is_free?: boolean
  status?: string
  condition?: string
  category?: string
  queue_count?: number
  photo_url?: string | null
  photos?: number
}

export interface ListingsPayload {
  total: number
  items: Listing[]
}

export function renderListings(data: ListingsPayload): string {
  if (!data.items?.length) {
    return '<div class="empty">No listings yet. Photograph an item to create the first one.</div>'
  }
  const cards = data.items
    .map((item) => {
      const photo = item.photo_url
        ? `<img src="${esc(item.photo_url)}" alt="" loading="lazy">`
        : '<div class="ph"></div>'
      const queue = item.queue_count
        ? `<span class="queue">${esc(item.queue_count)} in queue</span>`
        : ''
      return `<div class="card">
        ${photo}
        <div class="body">
          <div class="row"><span class="price">${formatPrice(item.price, item.is_free)}</span>${statusBadge(item.status)}</div>
          <div class="title">${esc(item.title)}</div>
          <div class="meta">${esc(item.condition ?? '')}${item.condition && item.category ? ' · ' : ''}${esc(item.category ?? '')}${queue}</div>
        </div>
      </div>`
    })
    .join('')
  return `<div class="head">${data.total} listing${data.total === 1 ? '' : 's'}</div><div class="grid">${cards}</div>`
}
