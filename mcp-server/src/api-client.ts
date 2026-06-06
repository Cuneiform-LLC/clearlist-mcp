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

/** Default request timeout: 120 seconds (increased from 30s — AI routes can take 60-120s) */
const DEFAULT_TIMEOUT_MS = 120_000

/** Max retries for transient errors (429, 500, 503) */
const MAX_RETRIES = 3

/** Backoff intervals in ms: 1s → 3s → 9s */
const RETRY_BACKOFF_MS = [1000, 3000, 9000]

/** HTTP status codes that are safe to retry */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503])

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
  private requestCount = 0
  private timeoutMs: number

  constructor(config: { baseUrl: string; sellerUid: string; apiKey?: string; timeoutMs?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.sellerUid = config.sellerUid
    this.apiKey = config.apiKey
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

  async get<T = unknown>(
    path: string,
    params?: Record<string, string>,
    opts?: { timeoutMs?: number; noRetryOnTimeout?: boolean },
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl)
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
    const url = new URL(path, this.baseUrl)
    return this.request<T>(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  }

  async put<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl)
    return this.request<T>(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  }

  async del<T = unknown>(
    path: string,
    params?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl)
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
    const url = new URL(path, this.baseUrl)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiKey) {
      headers['X-ClearList-API-Key'] = this.apiKey
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
          return { success: false, error: result.error, http_status: status }
        }
        // Network errors, 5xx, and unrecognized errors are transient — keep trying
        continue
      }

      const data = result.data
      if (!data) continue

      // Use property-presence check instead of truthiness: a successful
      // job that returns `0`, `false`, or `""` as its data payload should
      // exit the loop, not spin until the 120s timeout. Gemini round-6 P2.
      if (data.status === 'completed' && 'data' in data) {
        return { success: true, data: data.data as T }
      }

      if (data.status === 'failed') {
        return {
          success: false,
          error: (data.error as string) || 'AI generation failed',
        }
      }

      // Still processing — continue polling
    }

    return { success: false, error: `AI job timed out after ${timeoutMs}ms` }
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

    // Retry loop with exponential backoff for transient errors
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Abort after timeout to avoid hanging on slow/dead backends
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), callTimeoutMs)

      try {
        const response = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        })

        // Check if this is a retryable HTTP error
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
          const backoff = RETRY_BACKOFF_MS[attempt] || RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]
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
}
