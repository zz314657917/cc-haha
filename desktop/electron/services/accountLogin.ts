import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AccountErrorCode } from '../../src/lib/desktopHost/types'

export const ACCOUNT_ORIGIN = 'https://ai.3zapi.com'
export const DESKTOP_CLIENT = 'luoyeai-desktop'
export const SUMMARY_SCOPE = 'account-summary:read'
export const MODEL_SCOPE = 'model-key:provision'
const CALLBACK_PATH = '/luoyeai/callback'

export class AccountFailure extends Error {
  constructor(readonly code: AccountErrorCode) { super(code) }
}

/** No renderer data participates in the listener, browser origin, redirect, or verifier. */
export function authorizeInBrowser(open: (url: string) => Promise<void>, signal: AbortSignal, requestModel = false) {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  return new Promise<{ code: string; redirectUri: string; verifier: string }>((resolve, reject) => {
    let redirectUri = ''
    let finished = false
    const server = createServer((req, res) => {
      const reply = (status: number, message: string) => {
        res.writeHead(status, {
          'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close',
          'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        }).end(message)
      }
      const path = req.url ?? ''
      if (finished || req.method !== 'GET' || !path.startsWith(`${CALLBACK_PATH}?`) || `http://${req.headers.host}${CALLBACK_PATH}` !== redirectUri) {
        reply(404, 'Not found')
        return
      }
      const params = new URLSearchParams(path.slice(CALLBACK_PATH.length + 1))
      if (params.getAll('state').length !== 1 || params.get('state') !== state) {
        // Stray requests must not cancel the legitimate browser's pending login.
        reply(400, 'Invalid login state')
        return
      }
      const code = params.get('code')
      if (!code || !/^dsc_[A-Za-z0-9_-]{43}$/.test(code) || params.getAll('code').length !== 1 || params.has('error')) {
        reply(400, 'Authorization did not complete. Return to LuoyeAI.')
        fail(new AccountFailure(params.get('error') === 'access_denied' ? 'cancelled' : 'invalid-response'))
        return
      }
      reply(200, 'Return to LuoyeAI to finish logging in. You can close this tab.')
      finish()
      resolve({ code, redirectUri, verifier })
    })
    function finish() {
      finished = true
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeIdleConnections?.()
    }
    function fail(error: unknown) {
      if (finished) return
      finish()
      server.closeAllConnections?.()
      reject(error)
    }
    function abort() { fail(signal.reason) }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    server.on('error', () => fail(new AccountFailure('unavailable')))
    server.listen({ host: '127.0.0.1', port: 0, signal }, () => {
      const address = server.address()
      if (finished || !address || typeof address === 'string') return
      redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`
      const authorize = new URL('/desktop/authorize', ACCOUNT_ORIGIN)
      authorize.search = new URLSearchParams({
        client_id: DESKTOP_CLIENT, redirect_uri: redirectUri, response_type: 'code', scope: requestModel ? `${SUMMARY_SCOPE} ${MODEL_SCOPE}` : SUMMARY_SCOPE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
      }).toString()
      Promise.resolve().then(() => open(authorize.href)).catch(() => fail(new AccountFailure('unavailable')))
    })
  })
}
