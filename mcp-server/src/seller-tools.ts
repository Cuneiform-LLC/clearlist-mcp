/**
 * ClearList MCP — Seller Tools
 *
 * 19 tools that wrap the existing ClearList API routes for seller actions.
 * Each tool is a thin adapter: validate input → call API → format response.
 *
 * Auth: All requests include the X-ClearList-API-Key header. The backend
 * maps the key to the seller's UID. No Firebase token needed.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClearListApiClient } from './api-client.js'

/**
 * MCP Apps (SEP-1865) tool metadata: links a tool to the shared ui:// view.
 * Sets both the standard key (`ui.resourceUri`) and OpenAI's legacy Apps-SDK
 * key (`openai/outputTemplate`) so older ChatGPT ingestion also renders it.
 *
 * Defined as a literal rather than imported from ./ui/register.js: this file
 * is compiled by BOTH the node dist build and the Next.js remote endpoint,
 * and files on that dual path must keep relative imports type-only (node
 * needs `.js` specifiers, the bundler can't resolve them to .ts). Keep the
 * URI in sync with UI_APP_RESOURCE_URI in src/ui/register.ts — the entry
 * points (index.ts, /api/mcp route) call registerUiResources() there.
 */
const UI_TOOL_META: Record<string, unknown> = {
  ui: { resourceUri: 'ui://clearlist/app.html' },
  'openai/outputTemplate': 'ui://clearlist/app.html',
}

export function registerSellerTools(
  server: McpServer,
  api: ClearListApiClient,
): void {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. create_listing
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('create_listing', {
    title: 'Create Listing',
    description:
      'Send photos of a single item and get an AI-generated listing (Gemini 3.0 Pro) with title, description, price, dimensions, weight, and transport notes. The listing is saved to the seller\'s account. For multiple items at once, use bulk_create_listings instead. ' +
      'Example: { photos: ["data:image/jpeg;base64,..."], description: "Vintage wooden desk, some scratches on top" }',
    inputSchema: {
      photos: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe('Base64-encoded photos of the item (1-5 photos). Include data URL prefix like "data:image/jpeg;base64,..." or raw base64.'),
      description: z
        .string()
        .optional()
        .describe('Optional text description to help the AI (e.g., "IKEA Kallax shelf, 2 years old")'),
      voice_transcription: z
        .string()
        .optional()
        .describe('Optional voice transcription with additional details about the item'),
    },
    annotations: {
      title: 'Create Listing',
      readOnlyHint: false,
    },
  }, async ({ photos, description, voice_transcription }) => {
    // Step 1: Upload photos to Firebase Storage
    const uploadResult = await api.post<{
      fullUrls: string[]
      thumbnailUrls: string[]
      batchId: string
    }>('/api/items/bulk-upload', { photos })

    if (!uploadResult.success || !uploadResult.data) {
      return {
        content: [{ type: 'text' as const, text: `Failed to upload photos: ${uploadResult.error || 'Unknown error'}` }],
        isError: true,
      }
    }

    // Step 2: Generate AI listing from uploaded photos (polls async job until complete)
    const generateResult = await api.postWithJobPolling('/api/items/bulk-generate', {
      photoUrls: uploadResult.data.fullUrls,
      groupLabel: description || 'Item to identify',
      sellerContext: voice_transcription || undefined,
    })

    if (!generateResult.success || !generateResult.data) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: generateResult.error || 'Unknown error', message: 'Failed to generate listing from photos' }, null, 2) }],
        isError: true,
      }
    }

    const aiResult = (generateResult.data as Record<string, unknown>).listing || generateResult.data

    // Step 3: Save the item to the seller's account
    const createResult = await api.post('/api/items', {
      fromTry: true,
      photos: uploadResult.data.fullUrls,
      aiResult,
      ...(voice_transcription ? { voiceTranscription: voice_transcription } : {}),
    })

    if (!createResult.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: createResult.error || 'Unknown error', message: 'AI generated the listing but failed to save it', listing: aiResult }, null, 2) }],
        isError: true,
      }
    }

    // Step 4: Get price research
    const priceResult = await api.post('/api/items/bulk-price', {
      title: (aiResult as Record<string, unknown>).title,
      condition: (aiResult as Record<string, unknown>).condition,
      category: (aiResult as Record<string, unknown>).category,
    })

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Listing created successfully',
          item_id: (createResult.data as Record<string, unknown>)?.item_id,
          listing: aiResult,
          price_research: priceResult.success ? priceResult.data : null,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 2. bulk_create_listings
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('bulk_create_listings', {
    title: 'Bulk Create Listings',
    description:
      'Send many photos at once (up to 50). AI automatically groups them by item (detecting multiple angles of the same thing), generates listings with Gemini 3.0 Pro, researches market prices with Google Search grounding, and validates with QA. Returns all detected items with listings and pricing. This is the most efficient way to list multiple items. ' +
      'Example: { photos: ["data:image/jpeg;base64,...", "...up to 50"], seller_context: "Moving out of 2BR apartment, furniture is mostly IKEA" }',
    inputSchema: {
      photos: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe('Base64-encoded photos (1-50). Can be a mix of items — AI will group them automatically.'),
      seller_context: z
        .string()
        .optional()
        .describe('Optional context about the items (e.g., "Moving out of 2BR apartment, furniture is mostly IKEA, all 3 years old")'),
    },
    annotations: {
      title: 'Bulk Create Listings',
      readOnlyHint: false,
    },
  }, async ({ photos, seller_context }) => {
    // Step 1: Upload all photos to Firebase Storage
    const uploadResult = await api.post<{
      fullUrls: string[]
      thumbnailUrls: string[]
      batchId: string
      count: number
    }>('/api/items/bulk-upload', { photos })

    if (!uploadResult.success || !uploadResult.data) {
      return {
        content: [{ type: 'text' as const, text: `Failed to upload photos: ${uploadResult.error || 'Unknown error'}` }],
        isError: true,
      }
    }

    const { fullUrls, thumbnailUrls } = uploadResult.data

    // Step 2: Group photos by item (Agent 1 — uses streaming, handled by postStream)
    const groupResult = await api.postStream<{
      groups: Array<{ photo_indices: number[]; label: string; confidence: string; is_bundle?: boolean; bundle_components?: string[] }>
    }>('/api/items/bulk-group', {
      thumbnailUrls,
      totalPhotos: thumbnailUrls.length,
    })

    if (!groupResult.success || !groupResult.data) {
      return {
        content: [{ type: 'text' as const, text: `Failed to group photos: ${groupResult.error || 'Unknown error'}` }],
        isError: true,
      }
    }

    const groups = groupResult.data.groups

    // Step 3: For each group, generate listing → then price research with actual title
    // Process up to 3 groups concurrently for speed
    const CONCURRENCY = 3
    const items: Array<Record<string, unknown>> = []

    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      const batch = groups.slice(i, i + CONCURRENCY)
      const batchResults = await Promise.allSettled(
        batch.map(async (group) => {
          const groupPhotoUrls = group.photo_indices.map((idx: number) => fullUrls[idx])

          const isBundle = group.is_bundle || false
          const bundleComponents = group.bundle_components

          // Step 3a: Generate listing (polls async job until complete)
          const genResult = await api.postWithJobPolling('/api/items/bulk-generate', {
            photoUrls: groupPhotoUrls,
            groupLabel: group.label,
            groupConfidence: group.confidence,
            sellerContext: seller_context || undefined,
            isBundle,
            bundleComponents,
          })

          const listing = genResult.success
            ? (genResult.data as Record<string, unknown>)?.listing || genResult.data
            : null

          if (!listing) {
            return {
              group_label: group.label,
              photo_count: group.photo_indices.length,
              confidence: group.confidence,
              is_bundle: isBundle,
              item_id: null,
              listing: null,
              price_research: null,
              bundle_price: null,
              qa: null,
              status: 'failed' as const,
            }
          }

          // Step 3b: Price research — use bundle pricing for bundles, regular for single items
          let finalPricing = null
          let bundlePricing = null

          if (isBundle && bundleComponents?.length) {
            const bundleResult = await api.post('/api/items/bundle-price', {
              title: (listing as Record<string, unknown>).title,
              components: bundleComponents,
              condition: (listing as Record<string, unknown>).condition,
              category: (listing as Record<string, unknown>).category,
            })
            if (bundleResult.success) {
              bundlePricing = bundleResult.data
              // Also populate regular pricing for backward compatibility
              const bp = bundleResult.data as Record<string, unknown>
              finalPricing = {
                suggestedPrice: bp.bundlePrice,
                priceRange: bp.bundleRange,
                confidence: bp.confidence,
                summary: bp.summary,
                sources: bp.sources,
              }
            }
          }

          // Fall back to regular pricing if bundle pricing failed or not a bundle
          if (!finalPricing) {
            const priceResult = await api.post('/api/items/bulk-price', {
              title: (listing as Record<string, unknown>).title,
              condition: (listing as Record<string, unknown>).condition,
              category: (listing as Record<string, unknown>).category,
            })
            if (priceResult.success) finalPricing = priceResult.data
          }

          // Step 3c: QA check — runs AFTER price so it can validate price alignment
          const qaResult = await api.post('/api/items/bulk-qa', {
            listing,
            pricing: finalPricing,
            photoUrls: groupPhotoUrls,
          })
          const qa = qaResult.success ? qaResult.data : null

          // Step 3d: Save the item
          let itemId = null
          const saveResult = await api.post('/api/items', {
            fromTry: true,
            photos: groupPhotoUrls,
            aiResult: listing,
          })
          if (saveResult.success) {
            itemId = (saveResult.data as Record<string, unknown>)?.item_id
          }

          return {
            group_label: group.label,
            photo_count: group.photo_indices.length,
            confidence: group.confidence,
            is_bundle: isBundle,
            item_id: itemId,
            listing,
            price_research: finalPricing,
            bundle_price: bundlePricing,
            qa,
            status: itemId ? 'saved' : 'generated_but_not_saved',
          }
        }),
      )

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          items.push(result.value)
        } else {
          items.push({
            group_label: 'Unknown',
            photo_count: 0,
            confidence: 'low',
            item_id: null,
            listing: null,
            price_research: null,
            qa: null,
            status: 'failed',
            error: result.reason?.message || 'Processing failed',
          })
        }
      }
    }

    const savedCount = items.filter((i) => i.status === 'saved').length
    const failedCount = items.filter((i) => i.status === 'failed').length

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: `Processed ${groups.length} items: ${savedCount} saved, ${failedCount} failed`,
          total_photos: photos.length,
          total_items: groups.length,
          items,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 3. edit_listing
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('edit_listing', {
    title: 'Edit Listing',
    description:
      'Update any field on an existing listing. You can change the title, description, price, condition, dimensions, or any other field. ' +
      'Example: { item_id: "item_abc", price: 75, description: "Updated description" }',
    inputSchema: {
      item_id: z.string().describe('The item ID to edit'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      price: z.number().optional().describe('New price in dollars (0 for free)'),
      condition: z
        .enum(['Like New', 'Good', 'Fair', 'Used'])
        .optional()
        .describe('Item condition'),
      category: z
        .enum([
          'Furniture', 'Electronics', 'Kitchen', 'Decor', 'Outdoor',
          'Baby', 'Sports', 'Tools', 'Clothing', 'Other',
        ])
        .optional()
        .describe('Item category'),
      status: z
        .enum(['available', 'taken', 'inactive'])
        .optional()
        .describe('Item status (available, taken, or inactive)'),
      transport_notes: z.string().optional().describe('Pickup/transport notes'),
    },
    annotations: {
      title: 'Edit Listing',
      readOnlyHint: false,
    },
  }, async ({ item_id, ...updates }) => {
    const fields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) fields[key] = value
    }

    if (Object.keys(fields).length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No fields provided', message: 'Provide at least one field to change.' }, null, 2) }],
        isError: true,
      }
    }

    const result = await api.put(`/api/items/${item_id}`, fields)

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to update listing' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Listing updated successfully',
          item_id,
          updated_fields: Object.keys(fields),
          item: result.data,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 4. delete_listing
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('delete_listing', {
    title: 'Delete Listing',
    description:
      'Permanently delete a listing. Cannot delete items with active reservations.',
    inputSchema: {
      item_id: z.string().describe('The item ID to delete'),
    },
    annotations: {
      title: 'Delete Listing',
      readOnlyHint: false,
      destructiveHint: true,
    },
  }, async ({ item_id }) => {
    const result = await api.del(`/api/items/${item_id}`)

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to delete listing' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Listing deleted successfully',
          item_id,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 5. publish_page
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('publish_page', {
    title: 'Publish Sale Page',
    description:
      'Publish the seller\'s sale page. Requires city. Returns the shareable URL (e.g., clearlist.me/sarahs-stuff). Items are immediately visible to buyers. ' +
      'Example: { city: "Austin", payment_instructions: "Venmo or cash at pickup" }',
    inputSchema: {
      city: z.string().describe('City name (required)'),
      state: z.string().optional().describe('State/province'),
      country: z.string().optional().describe('Country'),
      payment_instructions: z
        .string()
        .optional()
        .describe('How buyers should pay (e.g., "Cash or Venmo @handle")'),
      custom_url: z
        .string()
        .optional()
        .describe('Custom URL slug (paid users only, e.g., "sarahs-stuff")'),
    },
    annotations: {
      title: 'Publish Sale Page',
      readOnlyHint: false,
    },
    _meta: UI_TOOL_META,
  }, async (args) => {
    const result = await api.post<{ slug: string; url: string }>('/api/pages/publish', args)

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to publish sale page' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Sale page published!',
          url: result.data?.url,
          slug: result.data?.slug,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 6. unpublish_page
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('unpublish_page', {
    title: 'Unpublish Sale Page',
    description:
      'Take the sale page offline. Existing reservations continue normally — only new visits and reservations are blocked. ' +
      'The custom URL is preserved and the page can be re-published anytime with publish_page.',
    inputSchema: {},
    annotations: {
      title: 'Unpublish Sale Page',
      readOnlyHint: false,
    },
  }, async () => {
    const result = await api.post('/api/pages/unpublish')

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to unpublish sale page' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Sale page unpublished',
          ...result.data as Record<string, unknown>,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 7. get_listings
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('get_listings', {
    title: 'Get Listings',
    description:
      'Get all items for the seller. Returns each item\'s title, price, status, dimensions, queue count, and photos.',
    inputSchema: {},
    annotations: {
      title: 'Get Listings',
      readOnlyHint: true,
    },
    _meta: UI_TOOL_META,
  }, async () => {
    const result = await api.get('/api/items')

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to fetch listings' }, null, 2) }],
        isError: true,
      }
    }

    const items = (result.data as Array<Record<string, unknown>>) || []

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          total: items.length,
          items: items.map((item) => ({
            item_id: item.item_id,
            title: item.title,
            price: item.price,
            is_free: item.is_free,
            status: item.status,
            condition: item.condition,
            category: item.category,
            dimensions: item.dimensions,
            weight: item.weight,
            requires_truck: item.requires_truck,
            queue_count: item.queue_count || 0,
            photos: (item.photos as string[] || []).length,
            // First photo URL so UI-rendering hosts (MCP Apps) can show a
            // thumbnail. Additive — agents that only read counts are unaffected.
            photo_url: (item.photos as string[] || [])[0] ?? null,
          })),
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 8. get_reservations
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('get_reservations', {
    title: 'Get Reservations',
    description:
      'Get all buyer reservations and conversations. Shows who reserved what, timer status, queue positions, and buyer messages.',
    inputSchema: {},
    annotations: {
      title: 'Get Reservations',
      readOnlyHint: true,
    },
    _meta: UI_TOOL_META,
  }, async () => {
    const result = await api.get('/api/conversations')

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to fetch reservations' }, null, 2) }],
        isError: true,
      }
    }

    const conversations = (result.data as Array<Record<string, unknown>>) || []

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          total: conversations.length,
          reservations: conversations.map((conv) => ({
            conversation_id: conv.conversation_id,
            buyer_email: conv.buyer_email,
            buyer_name: conv.buyer_name,
            unread_messages: conv.unread_count_seller,
            last_message: conv.last_message,
            // The reservation object only carries item_ids — surface the
            // display fields the API computes so agents and the MCP Apps
            // view can show WHAT was reserved without a second lookup.
            first_item_title: conv.first_item_title,
            item_count: conv.item_count,
            reservation: conv.reservation,
          })),
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 9. get_conversation
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('get_conversation', {
    title: 'Get Conversation',
    description:
      'Read the full message history of a conversation thread with a buyer. ' +
      'Returns all messages (sender_type, content, timestamp) plus conversation metadata and reservation context. ' +
      'Use get_reservations first to find the conversation_id, then call this before reply_to_buyer to read what the buyer said.',
    inputSchema: {
      conversation_id: z.string().describe('The conversation ID from get_reservations'),
    },
    annotations: {
      title: 'Get Conversation',
      readOnlyHint: true,
    },
  }, async ({ conversation_id }) => {
    const result = await api.get(`/api/conversations/${conversation_id}`)
    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error || 'Failed to get conversation'}` }],
        isError: true,
      }
    }

    type ConversationPayload = {
      conversation: {
        conversation_id: string
        buyer_email: string
        buyer_name?: string
        unread_count_seller: number
      }
      messages: Array<{ sender_type: string; content: string; type?: string; created_at: string }>
      reservation: {
        reservation_id: string
        status: string
        item_ids: string[]
        scheduled_pickup?: unknown
        expires_at?: unknown
      } | null
    }
    const data = result.data as ConversationPayload | undefined
    if (!data?.conversation) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Conversation not found' }, null, 2) }],
        isError: true,
      }
    }

    const { conversation, messages, reservation } = data

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          conversation: {
            conversation_id: conversation.conversation_id,
            buyer_email: conversation.buyer_email,
            buyer_name: conversation.buyer_name,
            unread_count: conversation.unread_count_seller,
          },
          messages: messages.map((msg: { sender_type: string; content: string; type?: string; created_at: string }) => ({
            sender_type: msg.sender_type,
            content: msg.content,
            type: msg.type,
            timestamp: msg.created_at,
          })),
          reservation: reservation ? {
            reservation_id: reservation.reservation_id,
            status: reservation.status,
            item_ids: reservation.item_ids,
            scheduled_pickup: reservation.scheduled_pickup,
            expires_at: reservation.expires_at,
          } : null,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 10. reply_to_buyer
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('reply_to_buyer', {
    title: 'Reply to Buyer',
    description:
      'Send a message to a buyer through the seller inbox. Use get_reservations first to find the conversation_id. ' +
      'Example: { conversation_id: "conv_abc", message: "Yes, the table is still available! When would you like to pick it up?" }',
    inputSchema: {
      conversation_id: z.string().describe('The conversation ID'),
      message: z.string().describe('Message text to send'),
      message_type: z
        .enum(['text', 'pickup_confirmed'])
        .optional()
        .default('text')
        .describe("Message type. Use 'text' for normal replies (default). Use 'pickup_confirmed' to notify buyer that pickup is confirmed."),
    },
    annotations: {
      title: 'Reply to Buyer',
      readOnlyHint: false,
    },
  }, async ({ conversation_id, message, message_type }) => {
    const result = await api.post(`/api/conversations/${conversation_id}`, {
      content: message,
      type: message_type || 'text',
    })

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to send message' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Message sent successfully',
          conversation_id,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 11. share_address
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('share_address', {
    title: 'Share Address',
    description:
      'Share the pickup address with a buyer. PRIVACY-SENSITIVE: You MUST ask the seller for confirmation before calling this tool. ' +
      'The address is sent as a message in the conversation and cannot be unsent.',
    inputSchema: {
      conversation_id: z.string().describe('The conversation ID'),
      address: z.string().describe('Full pickup address to share with the buyer'),
      confirmed: z
        .boolean()
        .describe('REQUIRED: You MUST confirm with the seller before sharing their address. Set to true only after the seller explicitly approves. Never set to true without asking first.'),
    },
    annotations: {
      title: 'Share Address',
      readOnlyHint: false,
    },
  }, async ({ conversation_id, address, confirmed }) => {
    if (!confirmed) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Address sharing requires seller confirmation',
            message: 'Ask the seller if they want to share their address with this buyer, then call again with confirmed: true.',
          }, null, 2),
        }],
        isError: true,
      }
    }

    const result = await api.post(`/api/conversations/${conversation_id}/address`, {
      address,
    })

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to share address' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Address shared with buyer',
          conversation_id,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 12. mark_picked_up
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('mark_picked_up', {
    title: 'Mark as Picked Up',
    description:
      'Mark an item as picked up / sold. Changes the item status to "taken".',
    inputSchema: {
      item_id: z.string().describe('The item ID to mark as picked up'),
    },
    annotations: {
      title: 'Mark as Picked Up',
      readOnlyHint: false,
    },
  }, async ({ item_id }) => {
    const result = await api.put(`/api/items/${item_id}`, {
      status: 'taken',
    })

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to mark item as picked up' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Item marked as picked up',
          item_id,
          status: 'taken',
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 13. get_page_stats
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('get_page_stats', {
    title: 'Get Page Stats',
    description:
      'Get stats for the published sale page: total views, item count, reservation count. Requires the page slug.',
    inputSchema: {
      slug: z.string().describe('The sale page slug (e.g., "sarahs-stuff")'),
    },
    annotations: {
      title: 'Get Page Stats',
      readOnlyHint: true,
    },
  }, async ({ slug }) => {
    const result = await api.get(`/api/pages/${slug}?stats_only=true`)

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to fetch page stats' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Page stats retrieved',
          stats: result.data,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 14. set_availability
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('set_availability', {
    title: 'Set Pickup Availability',
    description:
      'Configure pickup scheduling. Set weekly time windows when buyers can schedule pickups. Time format: "HH:mm" (24h). Days: "monday" through "sunday".',
    inputSchema: {
      scheduling_enabled: z
        .boolean()
        .optional()
        .describe('Enable or disable pickup scheduling'),
      slot_duration: z
        .union([z.literal(30), z.literal(60)])
        .optional()
        .describe('Slot duration in minutes: 30 or 60'),
      manual_availability: z
        .array(
          z.object({
            day_of_week: z.enum([
              'monday', 'tuesday', 'wednesday', 'thursday',
              'friday', 'saturday', 'sunday',
            ]).describe('Day of the week'),
            start_time: z.string().describe('Start time in HH:mm format (e.g., "09:00")'),
            end_time: z.string().describe('End time in HH:mm format (e.g., "17:00")'),
          }),
        )
        .optional()
        .describe('Weekly availability windows'),
      blocked_dates: z
        .array(z.string())
        .optional()
        .describe('Dates to block in YYYY-MM-DD format'),
    },
    annotations: {
      title: 'Set Pickup Availability',
      readOnlyHint: false,
    },
  }, async (args) => {
    const result = await api.put('/api/scheduling/availability', args)

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to update availability' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Availability updated successfully',
          config: result.data,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 15. generate_payment_link
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('generate_payment_link', {
    title: 'Generate Payment Link',
    description:
      'Generate a payment link for upgrading the seller\'s account. Send this link to the user — they tap it, pay in their browser, and come back. Two plans: "sale_pass" (Move Sale — $20, 50 items, 30 days) and "big_move" (Garage Sale — $39, 250 items, 60 days). Free tier: 3 items, always free (page expires every 30 days). Use check_tier_status first to see if an upgrade is needed.',
    inputSchema: {
      plan: z
        .enum(['sale_pass', 'big_move'])
        .describe('Plan to upgrade to: "sale_pass" ($20) or "big_move" ($39)'),
    },
    annotations: {
      title: 'Generate Payment Link',
      readOnlyHint: true,
    },
  }, async ({ plan }) => {
    const result = await api.post<{
      checkout_url: string
      plan: string
      plan_name: string
      items_limit: number
      duration_days: number
      already_paid?: boolean
      message: string
    }>('/api/payments/checkout-link', { plan })

    if (!result.success || !result.data) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to generate payment link' }, null, 2) }],
        isError: true,
      }
    }

    if (result.data.already_paid) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: result.data.message,
            already_paid: true,
          }, null, 2),
        }],
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: `Send this link to the user to upgrade to ${result.data.plan_name}:`,
          checkout_url: result.data.checkout_url,
          plan: result.data.plan,
          plan_name: result.data.plan_name,
          items_limit: result.data.items_limit,
          duration_days: result.data.duration_days,
          instructions: 'The user taps the link, pays in their browser, then comes back. Use check_tier_status to confirm the upgrade completed.',
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 16. prepare_crosspost
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('prepare_crosspost', {
    title: 'Prepare Cross-Post',
    description:
      'Format a listing for cross-posting to Facebook Marketplace. Returns the title, description, price, condition, category hint, location, and photos — ready for the seller to copy-paste into Facebook. Also returns a combined text block for quick copy-all.',
    inputSchema: {
      item_id: z.string().describe('The item ID to prepare for cross-posting'),
    },
    annotations: {
      title: 'Prepare Cross-Post',
      readOnlyHint: true,
    },
  }, async ({ item_id }) => {
    const result = await api.get(`/api/crosspost/prepare?itemId=${item_id}`)

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to prepare cross-post data' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Cross-post data ready. Copy these fields into Facebook Marketplace:',
          ...result.data as Record<string, unknown>,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 17. confirm_pickup
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('confirm_pickup', {
    title: 'Confirm Pickup',
    description:
      'Confirm that a buyer has picked up their reserved items. Marks all items in the reservation as "taken" (sold). ' +
      'Use get_reservations first to find the reservation details.',
    inputSchema: {
      reservation_id: z.string().describe('The reservation ID to confirm pickup for'),
    },
    annotations: {
      title: 'Confirm Pickup',
      readOnlyHint: false,
    },
  }, async ({ reservation_id }) => {
    // Fetch the reservation to get the cancel_token required by the pickup-confirm endpoint
    const reservationResult = await api.get(`/api/reservations/${reservation_id}`)
    if (!reservationResult.success || !reservationResult.data) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: reservationResult.error || 'Reservation not found', message: 'Failed to find reservation' }, null, 2) }],
        isError: true,
      }
    }

    const reservation = reservationResult.data as Record<string, unknown>
    const cancelToken = reservation.cancel_token as string
    if (!cancelToken) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No cancel token found on reservation', message: 'Cannot confirm pickup without a valid reservation token' }, null, 2) }],
        isError: true,
      }
    }

    // Call the pickup-confirm endpoint with action=sold
    const confirmResult = await api.get(
      `/api/reservations/${reservation_id}/pickup-confirm?action=sold&token=${encodeURIComponent(cancelToken)}`,
    )

    if (!confirmResult.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: confirmResult.error || 'Unknown error', message: 'Failed to confirm pickup' }, null, 2) }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Pickup confirmed — items marked as sold',
          reservation_id,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 18. get_profile
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('get_profile', {
    title: 'Get Profile',
    description:
      'Get the seller\'s account details — email, display name, tier, active items count, sale page URL, and scheduling status. ' +
      'Useful for confirming which account the agent is operating on.',
    inputSchema: {},
    annotations: {
      title: 'Get Profile',
      readOnlyHint: true,
    },
  }, async () => {
    // Use check_tier_status endpoint for tier info
    const tierResult = await api.get<{
      tier: string
      paid_plan: string | null
      items_count: number
      items_limit: number
      items_remaining: number
      expires_at: string | null
      is_expired: boolean
    }>('/api/payments/status')

    // Get listings to find the page slug
    const listingsResult = await api.get('/api/items')

    // Combine the data
    const tierData = tierResult.success ? tierResult.data : null
    const items = listingsResult.success
      ? (listingsResult.data as Array<Record<string, unknown>> || [])
      : []

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          tier: tierData?.tier || 'free',
          paid_plan: tierData?.paid_plan || null,
          items_count: tierData?.items_count || 0,
          items_limit: tierData?.items_limit || 3,
          items_remaining: tierData?.items_remaining || 0,
          expires_at: tierData?.expires_at || null,
          is_expired: tierData?.is_expired || false,
          total_listings: items.length,
          active_listings: items.filter((i) => i.status === 'available').length,
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 19. check_tier_status
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('check_tier_status', {
    title: 'Check Tier Status',
    description:
      'Check the seller\'s current plan, remaining item slots, and whether an upgrade is needed. Use this before creating listings to ensure capacity, and after sending a payment link to confirm the upgrade completed.',
    inputSchema: {},
    annotations: {
      title: 'Check Tier Status',
      readOnlyHint: true,
    },
  }, async () => {
    const result = await api.get<{
      tier: string
      paid_plan: string | null
      items_count: number
      items_limit: number
      items_remaining: number
      total_items_created: number
      lifetime_cap: number
      lifetime_remaining: number
      expires_at: string | null
      is_expired: boolean
      needs_upgrade: boolean
    }>('/api/payments/status')

    if (!result.success || !result.data) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Unknown error', message: 'Failed to check tier status' }, null, 2) }],
        isError: true,
      }
    }

    const d = result.data
    let summary: string
    if (d.needs_upgrade) {
      summary = `Upgrade needed! ${d.items_remaining} item slots remaining (${d.items_count}/${d.items_limit}). Use generate_payment_link to get an upgrade URL.`
    } else if (d.tier === 'expired') {
      summary = `Plan expired. Use generate_payment_link to renew.`
    } else {
      summary = `${d.tier} tier — ${d.items_remaining} item slots available (${d.items_count}/${d.items_limit})`
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          summary,
          ...d,
        }, null, 2),
      }],
    }
  })
}
