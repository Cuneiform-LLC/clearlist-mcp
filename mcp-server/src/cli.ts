#!/usr/bin/env node
/**
 * ClearList CLI — script seller actions against the ClearList REST API.
 *
 * Same thin-adapter rule as the MCP server: every command calls the public
 * /api/* routes via ClearListApiClient. Zero business logic here.
 *
 * Auth: `clearlist login <email>` → `clearlist verify <email> <code>` stores
 * the API key in ~/.clearlist/config.json. CLEARLIST_API_KEY overrides it.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClearListApiClient, type ApiResponse } from './api-client.js'

const DEFAULT_API_URL = 'https://clearlist.me'
const CONFIG_DIR = join(homedir(), '.clearlist')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
const CLI_VERSION = '0.3.1'

interface CliConfig {
  apiKey?: string
  email?: string
}

function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as CliConfig
  } catch {
    return {}
  }
}

function writeConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  try {
    chmodSync(CONFIG_PATH, 0o600)
  } catch {
    // Windows: chmod is a no-op; the file lives under the user profile.
  }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function fail(message: string, httpStatus?: number): never {
  const payload: Record<string, unknown> = { success: false, error: message }
  if (httpStatus !== undefined) payload.http_status = httpStatus
  process.stderr.write(JSON.stringify(payload) + '\n')
  process.exit(1)
}

/**
 * Parse `--flag value` pairs; returns { flags, positional }.
 * Every flag in this CLI takes a value, so a flag followed by another flag
 * (or nothing) is a user error — failing beats silently publishing
 * `city: "true"`.
 */
function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        fail(`Missing value for --${name}`)
      }
      flags[name] = next
      i++
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

/** Typos and unsupported flags must not be silently discarded. */
function rejectUnknownFlags(flags: Record<string, string>, allowed: string[]): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) {
      const hint = allowed.length > 0 ? ` Allowed: ${allowed.map((f) => `--${f}`).join(', ')}` : ''
      fail(`Unknown flag: --${name}.${hint}`)
    }
  }
}

function makeClient(requireAuth: boolean): ClearListApiClient {
  // Unauthenticated commands (login/verify) must not present a stale stored
  // key — the backend would log auth failures for what is a normal re-login.
  const apiKey = requireAuth
    ? process.env.CLEARLIST_API_KEY || readConfig().apiKey
    : undefined
  if (requireAuth && !apiKey) {
    fail('Not authenticated. Run: clearlist login <email>, then clearlist verify <email> <code>')
  }
  return new ClearListApiClient({
    baseUrl: process.env.CLEARLIST_API_URL || DEFAULT_API_URL,
    sellerUid: '',
    apiKey,
  })
}

function printResult(result: ApiResponse): void {
  // Only an explicit success:false is a failure — a 2xx body without the
  // { success } envelope is a successful raw response, not an error.
  if (result.success === false) {
    const hint =
      result.http_status === 401
        ? ' (API key invalid or expired — re-run: clearlist login <email>)'
        : ''
    fail((result.error || 'Request failed') + hint, result.http_status)
  }
  print(result.data ?? { success: true })
}

const HELP = `ClearList CLI v${CLI_VERSION} — https://clearlist.me/developers

Usage: clearlist <command> [args]

Auth
  login <email>                  Send a 6-digit sign-in code to the email
  verify <email> <code>          Verify the code, create/link the account, store the API key
  logout                         Delete the stored API key

Selling
  items                          List all listings with status
  publish --city <city> [--payment-instructions <text>]
                                 Publish the sale page, returns the shareable URL
  unpublish                      Take the sale page offline
  picked-up <itemId>             Mark an item as picked up (sold)

Buyers
  reservations                   List reservations and conversations
  reply <conversationId> <message...>
                                 Send a reply to a buyer

Account
  status                         Plan, capacity, and expiry for the signed-in seller

Options
  --help, -h                     Show this help
  --version, -v                  Show version

Environment
  CLEARLIST_API_KEY              API key (overrides ~/.clearlist/config.json)
  CLEARLIST_API_URL              API base URL (default: ${DEFAULT_API_URL})

Every command prints JSON, so output is pipeable to jq or other tools.
`

/** Flags each command accepts; commands not listed accept none. */
const ALLOWED_FLAGS: Record<string, string[]> = {
  publish: ['city', 'payment-instructions'],
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const { flags, positional } = parseArgs(rest)
  rejectUnknownFlags(flags, ALLOWED_FLAGS[command ?? ''] ?? [])

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return

    case '--version':
    case '-v':
      process.stdout.write(CLI_VERSION + '\n')
      return

    case 'login': {
      const email = positional[0]
      if (!email) fail('Usage: clearlist login <email>')
      const result = await makeClient(false).post('/api/auth/send-code', { email })
      if (!result.success) fail(result.error || 'Failed to send code')
      print({ success: true, message: `Code sent to ${email}. Next: clearlist verify ${email} <code>` })
      return
    }

    case 'verify': {
      const [email, code] = positional
      if (!email || !code) fail('Usage: clearlist verify <email> <code>')
      const result = await makeClient(false).post<{ apiKey?: string; uid: string; isNewUser: boolean }>(
        '/api/auth/verify-code',
        { email, code, agent: true },
      )
      if (!result.success) {
        fail(result.error || 'Verification failed — request a new code with: clearlist login ' + email, result.http_status)
      }
      const apiKey = result.data?.apiKey
      if (!apiKey) {
        // The code was ACCEPTED and consumed — requesting a new one would
        // loop forever. The problem is server-side (dev mode or a deployment
        // that ignores the agent flag).
        fail('Verification succeeded but the server returned no API key. Do NOT request a new code — the issue is server-side (dev mode or outdated deployment).')
      }
      try {
        writeConfig({ apiKey, email })
      } catch (err: unknown) {
        // Verification succeeded and the key exists server-side; losing it
        // here would orphan the key and burn the code. Hand it to the user.
        const message = err instanceof Error ? err.message : String(err)
        fail(`Signed in successfully, but storing the API key failed (${message}). Set it manually: CLEARLIST_API_KEY=${apiKey}`)
      }
      print({ success: true, message: `Signed in as ${email}. API key stored in ${CONFIG_PATH}.` })
      return
    }

    case 'logout': {
      const hadConfig = existsSync(CONFIG_PATH)
      if (hadConfig) rmSync(CONFIG_PATH)
      const envNote = process.env.CLEARLIST_API_KEY
        ? ' Note: CLEARLIST_API_KEY is set in this environment and still authenticates — unset it to fully log out.'
        : ''
      print({
        success: true,
        message: (hadConfig ? 'Logged out — stored API key deleted.' : 'No stored API key found.') + envNote,
      })
      return
    }

    case 'items':
      printResult(await makeClient(true).get('/api/items'))
      return

    case 'publish': {
      const city = flags['city']
      if (!city) fail('Usage: clearlist publish --city <city> [--payment-instructions <text>]')
      const body: Record<string, unknown> = { city }
      if (flags['payment-instructions']) body.payment_instructions = flags['payment-instructions']
      printResult(await makeClient(true).post('/api/pages/publish', body))
      return
    }

    case 'unpublish':
      printResult(await makeClient(true).post('/api/pages/unpublish'))
      return

    case 'picked-up': {
      const itemId = positional[0]
      if (!itemId) fail('Usage: clearlist picked-up <itemId>')
      printResult(await makeClient(true).put(`/api/items/${itemId}`, { status: 'taken' }))
      return
    }

    case 'reservations':
      printResult(await makeClient(true).get('/api/conversations'))
      return

    case 'reply': {
      const [conversationId, ...messageParts] = positional
      const message = messageParts.join(' ')
      if (!conversationId || !message) fail('Usage: clearlist reply <conversationId> <message...>')
      printResult(
        await makeClient(true).post(`/api/conversations/${conversationId}`, {
          content: message,
          type: 'text',
        }),
      )
      return
    }

    case 'status':
      printResult(await makeClient(true).get('/api/payments/status'))
      return

    default:
      fail(`Unknown command: ${command}. Run "clearlist help" for usage.`)
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
