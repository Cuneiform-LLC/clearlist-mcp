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
import type { ClearListApiClient, ApiResponse } from './api-client.js'

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
      // verify_code documents its retry limits; this one never mentioned that
      // sending a second code silently kills the first. An agent that re-sent
      // "to be safe" while the user was reading the first email put them into a
      // loop of typing codes that no longer worked.
      'Send a 6-digit verification code to an email address. This is the first step to create a ClearList account or sign in. The user will receive the code in their inbox. Ask them to tell you the code, then use verify_code to complete authentication. No API key needed for this step. ' +
      'Send ONE code and wait for the user to read it. Sending another invalidates the previous one, so a second send while they are fetching the first makes the code they are holding fail. Only re-send if they say they never received it or the code has expired (10 minutes).',
    inputSchema: {
      email: z
        .string()
        .email()
        .describe('The email address to send the verification code to'),
    },
    annotations: {
      title: 'Send Verification Code',
      readOnlyHint: false,
      // Delivers mail to an address the caller supplied — state change lands
      // outside ClearList entirely.
      openWorldHint: true,
      // A sent email cannot be recalled. OpenAI's own worked example of a
      // destructive side effect is "send messages ... that can't be undone".
      destructiveHint: true,
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
      // Creates an account and mints an API key. Both are tenant-private; no
      // publicly visible state changes, so this stays false despite being a write.
      openWorldHint: false,
      // Idempotent-ish and reversible: a fresh code can be requested, and the
      // key can be revoked.
      destructiveHint: false,
    },
  }, async ({ email, code }) => {
    /**
     * `/api/auth/verify-code` answers FLAT, not wrapped in `data`.
     *
     *   { success: true, customToken, isNewUser, uid, apiKey }
     *
     * Most routes here return `{ success, data }`, and this tool used to read
     * `result.data` accordingly — which is always undefined against this route,
     * so EVERY agent onboarding failed with "Verification succeeded but the
     * server returned no data", while the server had in fact created the
     * account and minted a key. The agent then retried and minted another.
     * Found 2026-08-06 by the E2E harness on its first run: two api_keys
     * existed for an account whose onboarding had "failed" twice.
     *
     * The flat shape is not a bug to fix in the route — the web client reads
     * `data.customToken` off it directly (src/lib/firebase/auth.ts), so it is a
     * published contract. The adapter is what has to bend.
     *
     * Same class as the pollJob defect in api-client.ts: reading the payload
     * one level deeper than the route actually returns it.
     */
    const result = await api.post<never>('/api/auth/verify-code', {
      email,
      code,
      agent: true, // Tells the backend to auto-generate an API key
    }) as ApiResponse<never> & {
      customToken?: string
      isNewUser?: boolean
      uid?: string
      apiKey?: string
    }

    if (!result.success) {
      // "No verification code found" after an apparently-failed attempt is the
      // one failure that must NOT be retried, and the old copy told the agent
      // to retry it. api-client retries POST on a network error or 5xx, and
      // /api/auth/verify-code is not idempotency-wrapped, so attempt one can
      // succeed server-side — consuming the code, creating the account, minting
      // a key — and lose the response in flight. The retry then finds the code
      // gone and reports "wrong code". An agent following the old advice sends
      // a new code and onboards again, leaving a live 30-day credential the
      // seller does not know exists. Detected by the message because the route
      // emits no machine-readable code for it.
      // Matched on the ONE message that means it, and nothing else.
      //
      // This alternation originally also carried `request a new one`, which is
      // shared prose: `Code expired. Please request a new one.` (route.ts:160)
      // matched it too. Codes expire after ten minutes, and this is the grandma
      // flow — the agent sends a code, the human goes to find their phone and
      // read six digits back. Crossing ten minutes is the NORMAL failure, and
      // the branch below tells the agent not to send a new code, which is the
      // only thing that fixes it. An expired code must fall through to the
      // default advice.
      const codeMissing = /no verification code found/i.test(result.error ?? '')
      const rateLimited = result.http_status === 429
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: result.error || 'Unknown error',
            http_status: result.http_status,
            message: codeMissing
              ? 'The code is no longer on file. This does NOT necessarily mean it was wrong: if an earlier attempt reached the server and its reply was lost, that attempt already consumed the code, created the account, and minted an API key. Do NOT call send_verification_code and start over — that mints a SECOND key the user never sees. Ask the user whether they can already sign in, or report this and stop.'
              : rateLimited
                // Two unrelated 429s share this status. The per-IP throttle
                // (15 per 10 minutes) clears on its own; the signup-velocity
                // ceiling can hold for up to an hour and, because the code is
                // consumed BEFORE that check runs, a retry lands on "no
                // verification code found" — the branch above, which says stop.
                // So the guidance here is start-over-later, not retry-this-code.
                // Do NOT claim attempts extend the window: the reset time is
                // fixed when the window opens, and an over-limit call is not
                // even counted.
                ? 'Rate limited. The code (if any) is spent, so retrying THIS code will not work. Tell the user to wait — a few minutes for an ordinary throttle, up to an hour if the server mentioned high signup volume — then start again with send_verification_code. Do not loop in the meantime.'
                : 'Verification failed. Ask the user to double-check the code. Codes expire after 10 minutes and allow 5 attempts — if it expired or all attempts failed, call send_verification_code for a fresh one.',
            retryable: !codeMissing && !rateLimited,
          }, null, 2),
        }],
        isError: true,
      }
    }

    // Read off `result` itself — see the flat-shape note above. The check is on
    // apiKey rather than on the object, because an onboarding that returns no
    // key is useless to the agent even though everything else "succeeded", and
    // that is the failure worth naming.
    const data = result
    if (!data.apiKey) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'No API key returned',
            message:
              'Verification succeeded but no API key came back, so no further tools can be used. ' +
              'The account may still have been created — do NOT loop on verify_code, each retry ' +
              'mints another key. Report this rather than retrying.',
          }, null, 2),
        }],
        isError: true,
      }
    }

    // Store the API key in the client for all subsequent requests. This is
    // what makes the rest of a stdio session authenticated (one process, one
    // client instance, mutated in place). The remote transport builds a
    // fresh client per HTTP request, so that mutation alone doesn't carry
    // forward there — the apiKey is also echoed below so the calling agent
    // can capture it and resend it (as X-ClearList-API-Key or
    // Authorization: Bearer) on subsequent tool calls in that conversation.
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
          apiKey: data.apiKey,
          available_tools: [
            'create_listing — Send photos to create an AI-generated listing',
            'bulk_create_listings — Send many photos at once (up to 50), AI groups and lists them all',
            'edit_listing — Update any field on a listing',
            'delete_listing — Remove a listing',
            'publish_page — Publish the sale page and get a shareable URL',
            'get_listings — See all items',
            'get_reservations — See buyer reservations and messages',
            'reply_to_buyer — Send a message to a buyer',
            // Named alongside confirm_pickup on purpose. This list is the FIRST
            // tool guidance a freshly-onboarded agent sees, and "mark item as
            // sold" alone sent it into the reserved-item refusal on the common
            // case — the registered description says one thing and onboarding
            // said another.
            'mark_picked_up — Mark an item sold when no reservation holds it (walk-up sale)',
            'confirm_pickup — Close out a reservation the buyer collected, or mark a no-show',
            'set_availability — Configure pickup scheduling',
            'check_tier_status — Check remaining item slots and plan details',
            'generate_payment_link — Get a payment link to upgrade the plan',
          ],
        }, null, 2),
      }],
    }
  })
}
