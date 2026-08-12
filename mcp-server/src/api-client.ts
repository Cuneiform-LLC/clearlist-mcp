/**
 * ClearList API Client
 *
 * HTTP wrapper that calls ClearList's Next.js API routes on behalf of a seller.
 * Authenticates via API key (X-ClearList-API-Key header).
 *
 * External agents (ChatGPT, Gemini, Claude, Manus) use API keys generated
 * from the seller's Settings page or auto-generated during onboarding.
 * The backend validates the key and maps it to the seller's UID —
 * no Firebase token needed.
 */

import { randomUUID } from 'node:crypto'

/** Default request timeout: 120 seconds (increased from 30s — AI routes can take 60-120s) */
const DEFAULT_TIMEOUT_MS = 120_000

/** Max retries for transient errors (429, 500, 503) */
const MAX_RETRIES = 3

/** Backoff intervals in ms: 1s → 3s → 9s */
const RETRY_BACKOFF_MS = [1000, 3000, 9000]

/**
 * Cap server-controlled text before it becomes part of a message an LLM reads.
 *
 * Whatever the API returns in `error` is interpolated into the string the MCP
 * tool hands back, which lands in the context of an agent holding a live seller
 * API key and tools like delete_listing and publish_page. Two reasons to bound
 * it: a multi-megabyte error body would blow out that context (measured at 5MB
 * against a hostile server), and a long free-text field is a comfortable place
 * to hide instructions aimed at the agent rather than the user. Truncating does
 * not make the text trustworthy — it makes it small and obviously quoted.
 *
 * The existing truncateBody() covers only UNPARSEABLE bodies; a well-formed
 * JSON `error` field bypassed it entirely.
 */
const MAX_AGENT_VISIBLE_ERROR_CHARS = 500

function truncateForAgent(text: unknown): string | undefined {
  if (text === undefined || text === null || text === '') return undefined

  // The parameter is typed `unknown`, not `string`, on purpose. Every value
  // reaching here came out of JSON.parse on a SERVER response, so the compiler's
  // guarantee stops at the network boundary — a route (or a proxy, or an error
  // page rendered as JSON) answering `{"error": {"code": "...", "details": ...}}`
  // hands us an object. That used to throw: `{}` is truthy, `({}).length` is
  // undefined, `undefined <= 500` is false, so execution fell through to
  // `.slice()` and raised `TypeError: text.slice is not a function` — INSIDE the
  // error path, which destroys the original failure and replaces it with a
  // confusing one. Found by review, not by a test; nothing in the suite feeds a
  // non-string error because our own routes never send one.
  const asString = typeof text === 'string' ? text : JSON.stringify(text)
  if (!asString) return undefined

  return asString.length <= MAX_AGENT_VISIBLE_ERROR_CHARS
    ? asString
    : `${asString.slice(0, MAX_AGENT_VISIBLE_ERROR_CHARS)}… (truncated from ${asString.length} chars)`
}

/** HTTP status codes that are safe to retry */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503])

/**
 * NOTE on caller-supplied ids: values interpolated into a URL PATH SEGMENT are
 * encoded at the interpolation site (see `encodePathSegment` in seller-tools.ts)
 * so they cannot break out of their segment and retarget the request. resolveUrl
 * below cannot do that job — once the string is assembled it cannot tell which
 * `/` or `?` came from the literal template and which came from the value. The
 * two layers are complementary: encoding preserves segment boundaries, resolveUrl
 * refuses traversal, host override, and anything outside /api/.
 */

/**
 * Truncate a non-JSON response body to a single line of bounded length.
 * HTML error pages can be many KB; we just want a hint, not the full DOM.
 */
function truncateBody(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /** Present when the route returns an async job instead of immediate data */
  job_id?: string
  /** Present when the route is processing asynchronously */
  status?: string
  /**
   * HTTP status code for failed responses. Set by request() on non-2xx.
   * Used by pollJob to distinguish terminal errors (4xx) from transient
   * ones (5xx, network) without guessing from error message text.
   */
  http_status?: number
}

export class ClearListApiClient {
  private baseUrl: string
  private sellerUid: string
  private apiKey: string | undefined
  private clientIp: string | undefined
  private requestCount = 0
  private timeoutMs: number

  constructor(config: {
    baseUrl: string
    sellerUid: string
    apiKey?: string
    timeoutMs?: number
    /**
     * The real caller's IP, when this client is proxying a request on
     * behalf of someone else (the remote MCP endpoint). Forwarded as
     * X-Forwarded-For so the underlying REST routes' per-IP rate limits
     * (e.g. send-code's) key on the actual caller instead of collapsing
     * every remote-MCP request into one shared 'unknown' bucket — this
     * client's own outbound fetch would otherwise be indistinguishable
     * from any other caller. The stdio distribution never sets this: a
     * local CLI process IS the real caller as far as the REST server's
     * TCP connection is concerned, so there's nothing to forward.
     */
    clientIp?: string
  }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.sellerUid = config.sellerUid
    this.apiKey = config.apiKey
    this.clientIp = config.clientIp
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get uid(): string {
    return this.sellerUid
  }

  get isAuthenticated(): boolean {
    return !!this.apiKey
  }

  /**
   * Set the API key after agent-driven onboarding (verify_code).
   * Called internally — the user never sees the key.
   */
  setApiKey(key: string): void {
    this.apiKey = key
  }

  get stats(): { requestCount: number } {
    return { requestCount: this.requestCount }
  }

  /**
   * Build the request URL, refusing path traversal.
   *
   * Tool arguments (item_id, conversation_id, slug, reservation_id) are
   * interpolated RAW into path segments, e.g. `/api/conversations/${id}`, and
   * `new URL()` NORMALIZES `../` segments. So a crafted id like
   * `"../auth/api-keys"` would silently retarget the request at a DIFFERENT
   * route (here: the durable-API-key mint route) while still resolving under the
   * same origin — an agent reaching an endpoint its tool never intended. This is
   * the single place every method builds a URL, so the guard lives here and
   * covers all of them at once rather than per call site.
   *
   * Returns the URL, or an { error } the caller surfaces as a normal
   * ApiResponse failure — this client never throws for a bad request (see
   * request()), so the guard must not either.
   */
  private resolveUrl(path: string): { url: URL } | { error: string } {
    // Only the PATH can traverse to another route; a `..` inside the query
    // string is a parameter value the destination route handles, not a segment.
    const rawPathname = path.split('?', 1)[0]

    // STRIP FIRST, THEN SCAN. The WHATWG URL parser DELETES tab, LF and CR
    // anywhere in the input before it resolves dot segments. So `".\t."` is not
    // `".."` to a naive string scan, but it IS `".."` to the parser: the path
    // `/api/conversations/.<TAB>./auth/api-keys` resolves to /api/auth/api-keys
    // — the durable-key mint route. Scanning the un-stripped string missed that
    // entirely. Everything below is checked on the same view the parser uses.
    const stripIgnored = (s: string): string => s.replace(/[\t\n\r]/g, '')

    let decodedPathname: string
    try {
      decodedPathname = decodeURIComponent(rawPathname)
    } catch {
      return { error: 'Invalid request path (malformed encoding).' }
    }
    // Backslash is a path separator for special schemes, so fold it too.
    const hasDotDotSegment = (s: string): boolean =>
      stripIgnored(s).replace(/\\/g, '/').split('/').some((seg) => seg === '..')
    if (hasDotDotSegment(rawPathname) || hasDotDotSegment(decodedPathname)) {
      return { error: 'Invalid request path (path traversal is not allowed).' }
    }

    // `new URL` THROWS on malformed input (e.g. "https://[bad/api/x"), and this
    // client's contract is to never throw for a bad request — request() always
    // returns { success: false, error }. So both parses are guarded.
    let base: URL
    let url: URL
    try {
      base = new URL(this.baseUrl)
      url = new URL(path, base)
    } catch {
      return { error: 'Invalid request path (malformed URL).' }
    }

    // Host pinning. `new URL(path, base)` lets an absolute or protocol-relative
    // `path` ("https://evil/…", "//evil/…", and "/\evil/…" — WHATWG treats a
    // leading slash-backslash as protocol-relative for special schemes) OVERRIDE
    // the host, which would send the seller's API-key header to an attacker.
    if (url.origin !== base.origin) {
      return { error: 'Invalid request path (host mismatch).' }
    }
    // Re-check the PARSED pathname, not just the input: this is the definitive,
    // post-normalization view, so any traversal the pre-parse scan missed still
    // has to survive this to reach the network.
    if (!url.pathname.startsWith('/api/')) {
      return { error: 'Invalid request path (outside the ClearList API).' }
    }
    if (url.pathname.split('/').some((seg) => seg === '..')) {
      return { error: 'Invalid request path (path traversal is not allowed).' }
    }
    return { url }
  }

  async get<T = unknown>(
    path: string,
    params?: Record<string, string>,
    opts?: { timeoutMs?: number; noRetryOnTimeout?: boolean },
  ): Promise<ApiResponse<T>> {
    const resolved = this.resolveUrl(path)
    if ('error' in resolved) return { success: false, error: resolved.error }
    const url = resolved.url
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, value)
      }
    }
    return this.request<T>(url.toString(), { method: 'GET' }, opts)
  }

  async post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const resolved = this.resolveUrl(path)
    if ('error' in resolved) return { success: false, error: resolved.error }
    const url = resolved.url
    return this.request<T>(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Generated HERE, once per logical call, not inside request()'s retry
        // loop — request() copies init.headers into its header map before the
        // loop starts, so every attempt reuses this exact key. That is the
        // whole point: a retried write must be recognisable as the SAME write.
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body ?? {}),
    })
  }

  async put<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const resolved = this.resolveUrl(path)
    if ('error' in resolved) return { success: false, error: resolved.error }
    const url = resolved.url
    return this.request<T>(url.toString(), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body ?? {}),
    })
  }

  async del<T = unknown>(
    path: string,
    params?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const resolved = this.resolveUrl(path)
    if ('error' in resolved) return { success: false, error: resolved.error }
    const url = resolved.url
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, value)
      }
    }
    return this.request<T>(url.toString(), { method: 'DELETE' })
  }

  /**
   * POST that handles streaming NDJSON responses (used by bulk-group).
   * Reads lines from the stream and returns the 'result' message content.
   * Retries on 429/500/503 with the same backoff as request().
   */
  async postStream<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const resolved = this.resolveUrl(path)
    if ('error' in resolved) return { success: false, error: resolved.error }
    const url = resolved.url

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Built once, outside the retry loop below, so all four attempts carry the
      // same key — the same reason post()/put() generate it at the call site.
      //
      // READ THIS BEFORE ASSUMING RETRIES ARE SAFE: the only route that uses
      // postStream is /api/items/bulk-group, and that route does NOT call
      // withIdempotency (see src/__tests__/api/idempotency-route-wiring.test.ts
      // for the list of routes that do). So the key is inert today: a retry on
      // 429/500/503 re-runs the Gemini grouping call and bills for it twice.
      // Sending the header anyway keeps this method consistent with post()/put()
      // and makes the fix server-side-only — wrap bulk-group and the duplicate
      // charge stops without touching this file.
      'Idempotency-Key': randomUUID(),
    }
    if (this.apiKey) {
      headers['X-ClearList-API-Key'] = this.apiKey
    }
    if (this.clientIp) {
      headers['X-Forwarded-For'] = this.clientIp
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

      try {
        this.requestCount++
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        })

        // Retry on transient HTTP errors
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
          const backoff = RETRY_BACKOFF_MS[attempt] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]
          console.warn(`[MCP] HTTP ${response.status} from ${url}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`)
          clearTimeout(timeoutId)
          await new Promise((resolve) => setTimeout(resolve, backoff))
          continue
        }

        const contentType = response.headers.get('content-type') || ''

        // If the response is NOT streaming, fall back to JSON parsing.
        // Same body-as-text guard as request() — non-JSON 4xx HTML pages
        // would otherwise throw SyntaxError and trigger 3x retries.
        if (!contentType.includes('text/event-stream') && !contentType.includes('ndjson')) {
          const responseText = await response.text()
          let json: ApiResponse<T>
          try {
            json = responseText
              ? (JSON.parse(responseText) as ApiResponse<T>)
              : ({ success: response.ok } as ApiResponse<T>)
          } catch {
            // Non-JSON body. Same response.ok branch as request() — a 2xx
            // empty/non-JSON body is a success, not an error.
            if (response.ok) {
              json = { success: true } as ApiResponse<T>
            } else {
              json = {
                success: false,
                error: truncateBody(responseText) || `HTTP ${response.status}`,
              } as ApiResponse<T>
            }
          }
          if (!response.ok) {
            return {
              ...json,
              success: false,
              error: json.error || `HTTP ${response.status}: ${response.statusText}`,
              http_status: response.status,
            }
          }
          return json
        }

        // Parse NDJSON streaming response — extract the 'result' message
        const text = await response.text()
        const lines = text.split('\n').filter((line) => line.trim())

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'result') {
              return parsed.content as ApiResponse<T>
            }
            if (parsed.type === 'error') {
              // Streaming errors arrived AFTER the HTTP 200 — there's no
              // real status code to attach. Tag with 422 (Unprocessable
              // Entity) so callers using http_status for terminal-vs-
              // transient branching see this as terminal: the request
              // succeeded transport-wise but the operation failed and a
              // retry won't help. Qwen P2.
              return {
                success: false,
                error: parsed.message || 'Streaming error',
                http_status: 422,
              }
            }
          } catch {
            // Skip unparseable lines (e.g., partial chunks)
          }
        }

        return {
          success: false,
          error: 'No result found in streaming response',
          http_status: 422,
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          if (attempt < 1) {
            console.warn(`[MCP] Timeout from ${url} (stream), retrying once`)
            continue
          }
          return { success: false, error: `Request timed out after ${this.timeoutMs}ms` }
        }

        // Network errors: retry if attempts remain
        if (attempt < MAX_RETRIES) {
          const backoff = RETRY_BACKOFF_MS[attempt] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]
          console.warn(`[MCP] Network error from ${url}: ${err instanceof Error ? err.message : err}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`)
          await new Promise((resolve) => setTimeout(resolve, backoff))
          continue
        }

        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Request failed: ${message}` }
      } finally {
        clearTimeout(timeoutId)
      }
    }

    return { success: false, error: 'Request failed after all retries' }
  }

  /**
   * Poll an async AI job until it completes or fails.
   * Used when a route returns { job_id, status: 'processing' } instead of immediate data.
   *
   * Polls IMMEDIATELY first (no leading delay), then exponential backoff between
   * subsequent polls: 2s → 4s → 8s → 10s cap. Times out at 120s. Polling first
   * lets instantly-completing jobs return without burning a 2s delay.
   */
  async pollJob<T = unknown>(jobId: string): Promise<ApiResponse<T>> {
    const startTime = Date.now()
    const timeoutMs = this.timeoutMs
    let pollCount = 0
    // Did we ever successfully read a job status? Distinguishes "the job ran
    // long" from "we never got an answer" in the timeout message below.
    let sawProcessingStatus = false
    let lastPollError: string | undefined
    let unknownStatus: string | undefined

    while (Date.now() - startTime < timeoutMs) {
      // Sleep BEFORE every poll except the first. pollCount=0 → no delay,
      // so instantly-completing jobs return immediately. pollCount=1 → 2s,
      // 2 → 4s, 3 → 8s, capped at 10s.
      //
      // Cap the sleep so we don't overshoot the timeout. Without this, a
      // 120s timeout could become 130s when the last sleep starts at t=119s
      // and runs the full 10s. Kimi round-9 P2.
      if (pollCount > 0) {
        const remaining = timeoutMs - (Date.now() - startTime)
        if (remaining <= 0) break
        const delay = Math.min(
          2000 * Math.pow(2, pollCount - 1),
          10_000,
          remaining,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        // Re-check after sleep — we may have slept up to `remaining` ms
        if (Date.now() - startTime >= timeoutMs) break
      }
      pollCount++

      // Cap the per-call timeout at the remaining poll budget. Without
      // this, request() would use this.timeoutMs (120s) per attempt AND
      // retry once, so a hanging backend could block 240s — double the
      // pollJob budget. noRetryOnTimeout disables the retry; pollJob's
      // own loop is the retry mechanism. Gemini round-10 P2.
      const remainingMs = timeoutMs - (Date.now() - startTime)
      if (remainingMs <= 0) break
      const result = await this.get<Record<string, unknown>>(
        `/api/ai-jobs/${jobId}`,
        undefined,
        { timeoutMs: remainingMs, noRetryOnTimeout: true },
      )

      // ── Terminal JOB outcomes are read BEFORE the transport-level `success`
      // check, because a failed job is not a failed request.
      //
      // GET /api/ai-jobs/{id} reports a failed job as HTTP **200** with
      // `{ success: false, status: 'failed', error, error_category }`
      // (ai-jobs/[jobId]/route.ts:43-50), and the server's own TTL expiry uses
      // the same shape. `success: false` with no `http_status` (it was a 200)
      // therefore fell into the transient branch below and `continue`d, so the
      // `status === 'failed'` check that used to live after it was unreachable
      // for every real failure. A prohibited-content rejection, an unparseable
      // model response or a server-side timeout all spun for the full 120s and
      // then reported "AI job timed out" — hiding an actionable reason behind a
      // misleading one.
      //
      // Found in review 2026-08-05, immediately after fixing the sibling
      // envelope-depth bug in this same loop, and initially missed because the
      // new test mocked a failed job as `success: true` — the same
      // test-agrees-with-the-bug trap that let the first one ship.
      if (result.status === 'failed') {
        // Bounded like every other server-controlled string that reaches an
        // agent's context. This one and the terminal-4xx return below were the
        // two paths MAX_AGENT_VISIBLE_ERROR_CHARS was written for and did not
        // cover — they were bounded only by our own routes happening to send
        // short messages, which is not a guarantee about a server we do not
        // control.
        return { success: false, error: truncateForAgent(result.error) || 'AI generation failed' }
      }

      if (result.status === 'completed') {
        // A completed job with no `data` key is terminal, not transient.
        // JSON.stringify omits an undefined `job.result`, so such a response
        // used to match none of these branches, fall past the `!result.success`
        // check (success is true), and spin to the timeout — then report
        // "status could not be read", blaming infrastructure for a job that
        // answered every single poll. Say what actually happened instead.
        if (!('data' in result)) {
          return { success: false, error: 'AI job completed but returned no result' }
        }
        return { success: true, data: result.data as T }
      }

      // The ONLY write that matters. Both branches above return, so the loop
      // can only fall through to the timeout after seeing 'processing' —
      // earlier versions also set the flag on those two paths, which was dead
      // and implied a broader "did we see any status" meaning than it has.
      if (result.status === 'processing') sawProcessingStatus = true

      if (!result.success) {
        // Distinguish terminal errors (auth/not-found) from transient ones
        // (network blip, timeout, 5xx). Without this, an expired API key or
        // a revoked job would cause us to spin for the full 120s timeout
        // before returning a misleading "AI job timed out" — wasting the
        // agent's budget and obscuring the real problem.
        //
        // We branch on HTTP status code, NOT error message text. Earlier
        // attempts at message matching (substring then exact-set) both
        // failed adversarial review:
        //   - Substring "not found" matched real 5xx bodies like
        //     "Database table not found".
        //   - Exact "not found" missed real 4xx bodies like "Job not found".
        //
        // request() now attaches http_status to every non-2xx response,
        // so we can rely on the status code alone. Terminal classes:
        //   400 (bad request) → malformed jobId or invalid params
        //   401 (auth)        → API key invalid
        //   403 (forbidden)   → permission denied
        //   404 (not found)   → job ID is bogus or revoked
        // Transient: 5xx (server hiccup), 429 (rate limited — already
        // retried inside request()), network errors (no http_status).
        // 400 added after Gemini round-7 — without it, malformed jobIds
        // spun for 120s instead of failing fast.
        const status = result.http_status
        const isTerminal =
          status === 400 ||
          status === 401 ||
          status === 403 ||
          status === 404
        if (isTerminal) {
          // result is ApiResponse<Record<string, unknown>> but we return
          // ApiResponse<T>. Since success is false, data is unused —
          // construct a minimal failure response in the caller's T.
          return { success: false, error: truncateForAgent(result.error), http_status: status }
        }
        // Network errors, 5xx, and unrecognized errors are transient — keep
        // trying, but remember why, so a run that never gets an answer can say
        // so instead of blaming AI latency.
        lastPollError = truncateForAgent(result.error)
        continue
      }

      // A SUCCESSFUL poll whose status we don't recognise.
      //
      // 'completed', 'failed' and 'processing' all returned or continued above,
      // so anything else lands here. It used to fall through silently and spin
      // to the timeout, then report "every poll failed" — an actively false
      // diagnostic, since every poll succeeded. 'queued' is the obvious future
      // addition to a job queue, and adding it server-side would have broken
      // every deployed client with a message blaming the network.
      //
      // Keep polling (an unknown status is more likely a new in-progress state
      // than a terminal one) but record it, so the timeout says what we saw.
      if (result.status !== 'processing') {
        unknownStatus = String(result.status)
      }
    }

    // Two very different failures used to share this one sentence.
    //
    // Reaching here means the budget expired. Either the job really did stay
    // 'processing' the whole time (slow generation), or every poll failed
    // transiently and we never learned anything at all (network down, 5xx
    // storm) — an infrastructure problem wearing an AI-latency costume.
    // `sawProcessingStatus` separates them so an agent, and whoever reads the log, is
    // pointed at the right thing.
    if (sawProcessingStatus) {
      // Hand back the job_id, because this "timeout" is usually not a failure.
      //
      // The server budgets a generation at 240s (bulk-generate's
      // GENERATION_BUDGET_MS) inside maxDuration 300. This client gives up at
      // 120s. Every generation landing in that 120-240s window — a duration
      // the SERVER treats as normal — is reported to the agent as a failure
      // while it completes fine, stays in ai_jobs for 15 minutes, and is
      // billed. Without the id, the agent's only recovery is a fresh
      // create_listing: another generation, another bill, another coin flip.
      // With it, the agent can poll /api/ai-jobs/{id} and collect the result
      // it already paid for.
      // Say what the AGENT can actually do. An earlier draft told it to poll
      // GET /api/ai-jobs/{id}; no registered tool wraps that route, and over
      // the hosted transport the agent holds an OAuth credential rather than
      // an API key, so it cannot call it out of band either. Advice that
      // cannot be followed is worse than none: a compliant agent stops, and
      // the seller ends up with no listing at all.
      //
      // What is TRUE here: this timeout fires while polling the generation,
      // which is step two of create_listing's four — the save has not happened
      // yet. So nothing was created, and retrying CANNOT duplicate a listing.
      // It does start a second generation and bill for it, which is worth
      // saying plainly so the agent tells the seller rather than looping.
      // The id is returned for logs and for a human debugging the run.
      return {
        success: false,
        error:
          `AI job ${jobId} did not finish within this client's ${timeoutMs}ms budget. ` +
          `The server allows longer, so it may still be completing — but nothing was ` +
          `saved yet, so no listing exists and NOTHING WILL BE DUPLICATED by trying ` +
          `again. Retrying starts a fresh generation and bills for it: do it once, ` +
          `tell the user it is taking longer than usual, and stop if it fails twice.`,
        job_id: jobId,
      }
    }
    if (unknownStatus) {
      return {
        success: false,
        error: `AI job reported an unrecognised status ("${truncateForAgent(unknownStatus)}") for ${timeoutMs}ms. This client understands processing, completed and failed — it may be out of date with the server.`,
      }
    }
    return {
      success: false,
      error: `AI job status could not be read for ${timeoutMs}ms — every poll failed. Last error: ${lastPollError || 'unknown'}`,
    }
  }

  /**
   * POST that handles async job responses automatically.
   * If the route returns { job_id, status: 'processing' }, polls until complete.
   * If it returns immediate data, returns it directly.
   */
  async postWithJobPolling<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const result = await this.post<T>(path, body)

    // Check if this is an async job response
    if (result.success && result.job_id) {
      return this.pollJob<T>(result.job_id)
    }

    // If response has status: 'processing' and job_id in the data
    const data = result.data as Record<string, unknown> | undefined
    if (data && typeof data === 'object' && 'job_id' in data && data.status === 'processing') {
      return this.pollJob<T>(data.job_id as string)
    }

    return result
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    opts?: { timeoutMs?: number; noRetryOnTimeout?: boolean },
  ): Promise<ApiResponse<T>> {
    this.requestCount++

    // Allow callers (e.g., pollJob) to override the per-attempt timeout
    // and to disable the retry-on-AbortError behavior. Without this,
    // pollJob's 120s budget could stretch to 240s when request() retried
    // a hung backend once. Gemini round-10 P2.
    const callTimeoutMs = opts?.timeoutMs ?? this.timeoutMs
    const retryOnTimeout = !opts?.noRetryOnTimeout

    // A DEADLINE for the whole call, not a fresh timeout per attempt.
    //
    // The comment above describes exactly this bug and fixes only half of it.
    // `noRetryOnTimeout` suppresses the retry-on-AbortError path, but the
    // RETRYABLE_STATUS_CODES path below (429/500/503) was untouched, and each
    // attempt armed a NEW AbortController with the FULL budget. A backend
    // answering 503 slowly therefore burned 4 x callTimeoutMs plus backoff —
    // roughly 8 minutes against a "120 second" budget, twice as bad as the
    // 240s case that prompted the original fix.
    //
    // This matters now in a way it did not before: pollJob was unreachable
    // until the fix in this same release, and the hosted transport at
    // /api/mcp runs with maxDuration = 300s (raised from 150 once the four-call
    // chain was accounted for). An overshoot there is not a slow
    // response, it is a Vercel kill mid-listing with no diagnostic.
    const deadline = Date.now() + callTimeoutMs

    // Why the last retryable attempt failed, so a deadline bail can name the
    // upstream cause ("upstream unavailable") instead of only reporting that
    // time ran out. Without this the deadline turns every slow-5xx storm into
    // a bare timeout, which is the same "infrastructure problem wearing an
    // AI-latency costume" that pollJob's sawProcessingStatus exists to prevent.
    let lastRetryableError: string | undefined

    // Build headers safely — init.headers could be a Headers instance,
    // an array of tuples, or a plain Record. Handle all three.
    const headers: Record<string, string> = {}
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => { headers[key] = value })
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) { headers[key] = value }
      } else {
        Object.assign(headers, init.headers)
      }
    }

    // Authenticate via API key — the backend maps this to the seller's UID
    if (this.apiKey) {
      headers['X-ClearList-API-Key'] = this.apiKey
    }
    if (this.clientIp) {
      headers['X-Forwarded-For'] = this.clientIp
    }

    // Retry loop with exponential backoff for transient errors
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Abort after timeout to avoid hanging on slow/dead backends. Bounded by
      // the REMAINING budget so retries can never extend the total past it.
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        // Same "timed out" wording as the AbortError path below: to a caller
        // these are one condition (the budget is gone), and only the reason
        // differs. Tools and tests branch on that phrase.
        const base = `Request timed out after ${callTimeoutMs}ms (${attempt} attempt(s))`
        return {
          success: false,
          error: lastRetryableError ? `${base}. Last upstream error: ${lastRetryableError}` : base,
        }
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), remainingMs)

      try {
        const response = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        })

        // Check if this is a retryable HTTP error
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
          // Best-effort read of WHY, purely for diagnostics — a failure to read
          // or parse it must not change the retry decision, so it falls back to
          // the bare status.
          lastRetryableError = await response
            .text()
            .then((text) => {
              try {
                const parsed = JSON.parse(text) as { error?: string }
                return truncateForAgent(parsed.error) || `HTTP ${response.status}`
              } catch {
                return `HTTP ${response.status}`
              }
            })
            .catch(() => `HTTP ${response.status}`)

          // Backoff is capped by the remaining budget too, so sleeping cannot
          // be what pushes the call past its deadline.
          const backoff = Math.min(
            RETRY_BACKOFF_MS[attempt] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1],
            Math.max(0, deadline - Date.now()),
          )
          console.warn(`[MCP] HTTP ${response.status} from ${url}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`)
          await new Promise((resolve) => setTimeout(resolve, backoff))
          continue
        }

        // Read body as TEXT first, then attempt JSON parse. Backends return
        // HTML error pages for 404/500/auth-proxy failures; await
        // response.json() on those throws SyntaxError, which the catch
        // block below would mistake for a network error and retry 3x with
        // backoff. Reading text first lets us preserve http_status even
        // when the body is unparseable. Gemini round-5 P0.
        const responseText = await response.text()
        let json: ApiResponse<T>
        try {
          json = responseText
            ? (JSON.parse(responseText) as ApiResponse<T>)
            : ({ success: response.ok } as ApiResponse<T>)
        } catch {
          // Body is non-JSON. Branch on response.ok: a 2xx with non-JSON
          // body (e.g., 204 No Content, 200 with plain text) is a SUCCESS,
          // not an error. Without this check, successful DELETEs and empty
          // 200 ack responses would surface as 'Unexpected token <' errors.
          // Gemini round-6 P1.
          if (response.ok) {
            json = { success: true } as ApiResponse<T>
          } else {
            json = {
              success: false,
              error: truncateBody(responseText) || `HTTP ${response.status}`,
            } as ApiResponse<T>
          }
        }

        // 409 idempotency_conflict means OUR OWN earlier attempt for this key
        // is still executing server-side. The server's documented contract is
        // "retry after a short delay" — surfacing it would turn a slow write
        // into a spurious failure, and the agent's natural response (call the
        // tool again with a NEW key) is exactly the duplicate we are
        // preventing. Narrowed to the code, not the bare status, so genuine
        // 409s from other routes still propagate.
        if (
          response.status === 409 &&
          (json as { code?: string }).code === 'idempotency_conflict' &&
          attempt < MAX_RETRIES
        ) {
          const backoff = Math.min(
            RETRY_BACKOFF_MS[attempt] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1],
            Math.max(0, deadline - Date.now()),
          )
          console.warn(`[MCP] idempotency conflict on ${url}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`)
          await new Promise((resolve) => setTimeout(resolve, backoff))
          continue
        }

        // Preserve HTTP status on every non-2xx response so callers (e.g.,
        // pollJob) can do reliable status-based branching instead of
        // guessing terminality from arbitrary error message text.
        if (!response.ok) {
          return {
            ...json,
            success: false,
            error: json.error || `HTTP ${response.status}: ${response.statusText}`,
            http_status: response.status,
          }
        }

        return json
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // Retry once on timeout — UNLESS the caller explicitly disabled
          // retry-on-timeout (pollJob does, since it has its own retry loop
          // and doesn't want a 120s call to stretch to 240s on a hang).
          if (retryOnTimeout && attempt < 1) {
            console.warn(`[MCP] Timeout from ${url}, retrying once`)
            continue
          }
          return { success: false, error: `Request timed out after ${callTimeoutMs}ms` }
        }

        // Network errors: retry if attempts remain
        if (attempt < MAX_RETRIES) {
          const backoff = Math.min(
            RETRY_BACKOFF_MS[attempt] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1],
            Math.max(0, deadline - Date.now()),
          )
          console.warn(`[MCP] Network error from ${url}: ${err instanceof Error ? err.message : err}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`)
          await new Promise((resolve) => setTimeout(resolve, backoff))
          continue
        }

        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Request failed: ${message}` }
      } finally {
        clearTimeout(timeoutId)
      }
    }

    return { success: false, error: 'Request failed after all retries' }
  }
}
