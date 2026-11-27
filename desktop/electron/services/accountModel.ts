import { createServer } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AccountVault } from './accountVault'
import { selectLuoyeAiModels } from '../../src/lib/luoyeAiSetup'
import type { ModelMapping } from '../../src/types/provider'
import { ACCOUNT_ORIGIN } from './accountLogin'

export interface AccountModel {
  install(userId: string, key: string): Promise<void>
  clear(): Promise<void>
  resync?(): Promise<void>
}
type LocalAccess = { serverUrl: string; token: string }
/** The sidecar gets a per-launch relay capability, never the model key. Only this
 * process adds the real Authorization header, after choosing a literal endpoint. */
export class DesktopModelRelay implements AccountModel {
  private readonly capability = randomBytes(32).toString('base64url')
  private active?: { userId: string; revision: number; key: string; models: ModelMapping; abort: AbortController }
  private pending?: AbortController
  private revision = 0
  private readonly server = createServer((req, res) => {
    const active = this.active
    const path = req.url
    const prefix = `/luoye-account-${active?.userId}/v1/`
    const endpoint = path === `${prefix}messages` ? '/v1/messages' : path === `${prefix}responses` ? '/v1/responses' : null
    if (!active || !endpoint || req.method !== 'POST' || req.headers.origin !== undefined || req.headers.authorization !== `Bearer ${createHmac('sha256', this.capability).update(`model:luoye-account-${active.userId}:${active.revision}`).digest('base64url')}`) {
      res.writeHead(403).end(); return
    }
    const downstream = new AbortController()
    res.once('close', () => downstream.abort())
    const signal = AbortSignal.any([active.abort.signal, downstream.signal])
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${active.key}` }
    if (endpoint === '/v1/messages') {
      headers['anthropic-version'] = '2023-06-01'
      if (typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta']
    }
    void (async () => {
      const init = { method: 'POST', headers, body: Readable.toWeb(req), duplex: 'half', signal, redirect: 'error', credentials: 'omit', cache: 'no-store' } as RequestInit
      const response = await this.send(`${ACCOUNT_ORIGIN}${endpoint}`, init)
      if (!response.ok || !response.body) {
        await response.body?.cancel(); res.writeHead(response.ok ? 502 : response.status).end('Model request failed'); return
      }
      res.writeHead(200, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' })
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res, { signal })
    })().catch(() => { if (!res.headersSent) res.writeHead(502).end('Model service unavailable'); else res.destroy() })
  })
  private startup?: Promise<Record<string,string>>
  constructor(private readonly vault: AccountVault, private readonly local: () => LocalAccess | null, private readonly send: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
  /** Only for the spawned server sidecar environment; stripped on its first import. */
  serverEnv() {
    return this.startup ??= new Promise<Record<string,string>>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        this.server.unref()
        const address = this.server.address()
        if (!address || typeof address === 'string') { reject(new Error('Model service unavailable')); return }
        resolve({ LUOYE_MODEL_RELAY_PORT: String(address.port), LUOYE_MODEL_RELAY_TOKEN: this.capability })
      })
    }).catch(error => { this.startup = undefined; throw error })
  }
  private async sync(userId: string | null, revision: number, models?: ModelMapping) {
    const local = this.local()
    if (!local || !/^http:\/\/127\.0\.0\.1:\d+$/.test(local.serverUrl)) throw new Error('Model service unavailable')
    const body = JSON.stringify({ userId, revision, models })
    const mac = createHmac('sha256', this.capability).update(body).digest('hex')
    const response = await fetch(`${local.serverUrl}/api/providers/desktop-account-sync`, { method: 'POST', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json', 'X-Luoye-Model-Signature': mac }, body })
    if (!response.ok) throw new Error('Model configuration unavailable')
  }
  async install(userId: string, key: string) {
    const revision = ++this.revision
    this.active?.abort.abort(); this.active = undefined
    this.pending?.abort()
    const abort = this.pending = new AbortController()
    try {
      // Use the permitted group's live catalog, not the preset's example model.
      const response = await this.send(`${ACCOUNT_ORIGIN}/v1/models`, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]), headers: { Accept: 'application/json', Authorization: `Bearer ${key}` } })
      if (!response.ok) { await response.body?.cancel(); throw new Error('Model catalog unavailable') }
      const catalog = await response.json()
      const ids: string[] = Array.isArray(catalog?.data) ? catalog.data.flatMap((entry: { id?: unknown } | null) =>
        typeof entry?.id === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(entry.id) ? [entry.id] : []) : []
      const selection = selectLuoyeAiModels(ids)
      const models = selection.claude ?? selection.gpt
      if (!models || revision !== this.revision) throw new Error('Account model unavailable')
      const record = JSON.stringify({ userId, key })
      this.vault.save(record)
      if (this.vault.read() !== record) throw new Error('Protected model storage unavailable')
      await this.sync(userId, revision, models)
      if (revision !== this.revision) throw new Error('Account changed')
      this.active = { userId, revision, key, models, abort }
    } catch (error) {
      if (revision === this.revision) await this.clear().catch(() => {})
      throw error
    } finally { if (this.pending === abort) this.pending = undefined }
  }
  async clear() {
    const revision = ++this.revision
    this.active?.abort.abort(); this.active = undefined
    this.pending?.abort()
    try { this.vault.clear() } finally { await this.sync(null, revision) }
  }
  async resync() {
    const active = this.active
    const revision = ++this.revision
    await this.sync(active?.userId ?? null, revision, active?.models)
    if (active && revision === this.revision) active.revision = revision
  }
  close() { this.pending?.abort(); this.active?.abort.abort(); this.active = undefined; this.revision++; this.server.close(); this.server.closeAllConnections() }
}
