/**
 * Single MCP App view shared by get_listings, publish_page, get_reservations,
 * create_upload_session and share_address. One bundle instead of five because
 * the ext-apps runtime (~400KB with the protocol schema) would otherwise be
 * inlined per view.
 *
 * Kept to a shell on purpose. `mountView` touches the DOM and the ext-apps
 * runtime at import time, so anything defined here is unreachable from a test
 * — which is how the payload dispatch shipped a bug for a month. The dispatch
 * lives in `dispatch.ts` and the address card's markup in `address-confirm.ts`,
 * where both are pure functions with their own tests.
 */
import { mountView } from './shared'
import { renderPayload, selectView, type AnyPayload } from './dispatch'
import {
  renderAddressResult,
  renderAddressSending,
  type AddressConfirmPayload,
} from './address-confirm'

mountView<AnyPayload>('ClearList', renderPayload, async (action, ctx) => {
  if (action !== 'approve') return

  // Re-check the payload kind rather than trusting the action name. The bundle
  // serves five tools through one root, and a button label is not proof of
  // which card is on screen; without this, an `approve` from some future card
  // would call the address tool.
  if (selectView(ctx.data) !== 'address-confirm') return

  const data = ctx.data as AddressConfirmPayload
  const name = String(data.recipient?.name ?? 'the buyer')
  const token = String(data.confirmation_token ?? '')
  const conversationId = String(data.conversation_id ?? '')
  if (!token || !conversationId) return

  ctx.setHtml(renderAddressSending(name))

  const result = await ctx.callTool('confirm_address_share', {
    conversation_id: conversationId,
    confirmation_token: token,
  })

  ctx.setHtml(renderAddressResult(result.ok, name, result.message))
})
