/**
 * ClearList MCP — Onboarding Tools
 *
 * These 2 tools handle the agent-driven account creation flow.
 * They do NOT require an API key — they're the tools that GET you one.
 *
 * Flow:
 *   1. Agent calls send_verification_code({ email: "grandma@gmail.com" })
 *   2. Grandma checks email, tells agent the 6-digit code
 *   3. Agent calls verify_code({ email: "grandma@gmail.com", code: "482019" })
 *   4. ClearList creates account (if new) + returns API key
 *   5. Agent stores API key internally — all subsequent calls are authenticated
 *
 * The user never visits clearlist.me, never generates a key, never sees one.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClearListApiClient } from './api-client.js'

export function registerOnboardingTools(
  server: McpServer,
  api: ClearListApiClient,
): void {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. send_verification_code
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('send_verification_code', {
    title: 'Send Verification Code',
    description:
      'Send a 6-digit verification code to an email address. This is the first step to create a ClearList account or sign in. The user will receive the code in their inbox. Ask them to tell you the code, then use verify_code to complete authentication. No API key needed for this step.',
    inputSchema: {
      email: z
        .string()
        .email()
        .describe('The email address to send the verification code to'),
    },
    annotations: {
      title: 'Send Verification Code',
      readOnlyHint: false,
    },
  }, async ({ email }) => {
    const result = await api.post('/api/auth/send-code', { email })

    if (!result.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: result.error || 'Unknown error',
            message: 'Failed to send verification code. Check the email address and try again.',
          }, null, 2),
        }],
        isError: true,
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: `Verification code sent to ${email}. Ask the user to check their email and tell you the 6-digit code.`,
          email,
          next_step: 'Call verify_code with the email and the 6-digit code the user provides.',
        }, null, 2),
      }],
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 2. verify_code
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool('verify_code', {
    title: 'Verify Code & Authenticate',
    description:
      'Verify the 6-digit code and authenticate. If the email is new, a ClearList account is created automatically. Returns an API key that authenticates all subsequent calls. The user never needs to visit clearlist.me or know about API keys — this happens behind the scenes. IMPORTANT: After this succeeds, all other tools (create_listing, bulk_create_listings, publish_page, etc.) become available. RETRY LIMITS: Max 5 attempts per code. If all 5 fail, the code is invalidated — call send_verification_code again to get a new one. Codes expire after 10 minutes.',
    inputSchema: {
      email: z.string().email().describe('The email address that received the code'),
      code: z.string().length(6).describe('The 6-digit verification code from the email'),
    },
    annotations: {
      title: 'Verify Code & Authenticate',
      readOnlyHint: false,
    },
  }, async ({ email, code }) => {
    const result = await api.post<{
      customToken: string
      isNewUser: boolean
      uid: string
      apiKey?: string
    }>('/api/auth/verify-code', {
      email,
      code,
      agent: true, // Tells the backend to auto-generate an API key
    })

    if (!result.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: result.error || 'Unknown error',
            message: 'Verification failed. Ask the user to double-check the code. Max 5 attempts per code — if all fail, call send_verification_code for a new one.',
          }, null, 2),
        }],
        isError: true,
      }
    }

    const data = result.data
    if (!data) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'No data returned',
            message: 'Verification succeeded but the server returned no data. This is unexpected — try again.',
          }, null, 2),
        }],
        isError: true,
      }
    }

    // Store the API key in the client for all subsequent requests
    if (data.apiKey) {
      api.setApiKey(data.apiKey)
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: data.isNewUser
            ? `Account created for ${email}! You can now create listings, publish sale pages, and manage everything for this seller.`
            : `Signed in as ${email}. You can now manage their ClearList sale.`,
          is_new_user: data.isNewUser,
          authenticated: true,
          available_tools: [
            'create_listing — Send photos to create an AI-generated listing',
            'bulk_create_listings — Send many photos at once (up to 50), AI groups and lists them all',
            'edit_listing — Update any field on a listing',
            'delete_listing — Remove a listing',
            'publish_page — Publish the sale page and get a shareable URL',
            'get_listings — See all items',
            'get_reservations — See buyer reservations and messages',
            'reply_to_buyer — Send a message to a buyer',
            'share_address — Share pickup address with a buyer',
            'mark_picked_up — Mark item as sold',
            'set_availability — Configure pickup scheduling',
            'check_tier_status — Check remaining item slots and plan details',
            'generate_payment_link — Get a payment link to upgrade the plan',
          ],
        }, null, 2),
      }],
    }
  })
}
