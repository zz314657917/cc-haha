import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AccountErrorCode } from '../../src/lib/desktopHost/types'

export const ACCOUNT_ORIGIN = 'https://ai.3zapi.com'
export const DESKTOP_CLIENT = 'luoyeai-desktop'
export const SUMMARY_SCOPE = 'account-summary:read'
export const MODEL_SCOPE = 'model-key:provision'
const CALLBACK_PATH = '/luoyeai/callback'
const receiptStyle = `
  :root { color-scheme: light dark; font-family: system-ui, "Microsoft YaHei", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; background: #f5f5f4; color: #262624; }
  main { width: min(100%, 24rem); padding: 30px; border: 1px solid #dededb; border-radius: 16px; background: #fff; box-shadow: 0 8px 28px #0000000d; text-align: center; }
  small { color: #656560; font-weight: 600; }
  h1 { margin: 12px 0 8px; font-size: 1.25rem; }
  p { margin: 0; line-height: 1.7; }
  @media (prefers-color-scheme: dark) { body { background: #20201e; color: #eee; } main { background: #292927; border-color: #444440; } small { color: #bdbdb8; } }
`
const receiptStyleHash = createHash('sha256').update(receiptStyle).digest('base64')
const receiptPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>浏览器授权已完成 · 落叶AI</title><style>${receiptStyle}</style></head>
<body><main><small>落叶AI</small><h1>浏览器授权已完成</h1><p>请返回落叶AI 客户端完成登录。此标签页可以关闭。</p></main></body></html>`

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
          'Content-Type': status === 200 ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store', Connection: 'close', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': `default-src 'none'; frame-ancestors 'none'; style-src 'sha256-${receiptStyleHash}'`,
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
      reply(200, receiptPage)
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
