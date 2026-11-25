import type { AccountAnnouncement, AccountAnnouncementListInput, AccountAnnouncementReadInput, AccountErrorCode, AccountProfile, AccountResult, AccountStatus, DesktopHost } from '../../src/lib/desktopHost/types'
import { ACCOUNT_ORIGIN, AccountFailure, authorizeInBrowser, DESKTOP_CLIENT } from './accountLogin'
import type { AccountVault } from './accountVault'

const DESKTOP_ACCESS = /^dsa_[A-Za-z0-9_-]{43}$/
const DESKTOP_REFRESH = /^dsr_[A-Za-z0-9_-]{43}$/
const SCOPE = 'profile announcements:read announcements:read-state'
const messages: Record<AccountErrorCode, string> = {
  cancelled: 'Login cancelled.', timeout: 'Login timed out.', unavailable: 'The desktop account service is unavailable.',
  unauthorized: 'Please sign in again.', 'invalid-state': 'Invalid login state.', network: 'Cannot reach the account service.',
  'invalid-response': 'Unexpected response from the account service.', 'not-found': 'Announcement not found.',
  'rate-limited': 'Please try again later.', unknown: 'Account action failed.',
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AccountFailure('invalid-response')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new AccountFailure('invalid-response')
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new AccountFailure('invalid-response')
  return String(value)
}
function parseItems(data: unknown): AccountAnnouncement[] {
  if (!Array.isArray(data)) throw new AccountFailure('invalid-response')
  return data.map(item => {
    const a = record(item)
    return { id: id(a.id), title: text(a.title), body: text(a.content), publishedAt: text(a.starts_at ?? a.created_at), ...(a.read_at ? { readAt: text(a.read_at) } : {}) }
  })
}
async function result<T>(action: () => Promise<T>): Promise<AccountResult<T>> {
  try { return { ok: true, data: await action() } } catch (error) {
    const code = error instanceof AccountFailure ? error.code : 'unknown'
    return { ok: false, error: { code, message: messages[code] } }
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Options = { vault: AccountVault; open: (url: string) => Promise<void>; fetch?: Fetch; now?: () => number; loginTimeoutMs?: number }

type AccountHost = DesktopHost['account']

export class AccountService implements AccountHost {
  private refresh: string | null
  private access: { token: string; expires: number } | null = null
  private pending?: AbortController
  private generation = 0
  private refreshing?: Promise<void>
  constructor(private readonly options: Options) {
    const saved = options.vault.read()
    this.refresh = saved && DESKTOP_REFRESH.test(saved) ? saved : null
  }

  private now() { return this.options.now?.() ?? Date.now() }
  private assertCurrent(epoch: number) {
    if (epoch !== this.generation) throw new AccountFailure('cancelled')
  }
  private async request(path: string, options: { body?: object; token?: string; probe?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const { body, token, probe, signal } = options
    const deadline = AbortSignal.timeout(15_000)
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
    let response: Response
    let envelope: Record<string, unknown>
    try {
      response = await (this.options.fetch ?? fetch)(`${ACCOUNT_ORIGIN}/api/v1/desktop${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: combined,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      // On older installations the SPA catch-all may return an HTML document with status 200.
      if (!response.headers.get('content-type')?.includes('application/json')) throw new AccountFailure('unavailable')
      envelope = record(await response.json())
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error instanceof AccountFailure) throw error
      throw new AccountFailure(deadline.aborted ? 'timeout' : error instanceof SyntaxError ? 'invalid-response' : 'network')
    }
    if (probe) {
      if (response.status === 401 && envelope.reason === 'desktop_unauthorized') return
      throw new AccountFailure(response.status === 429 ? 'rate-limited' : 'unavailable')
    }
    if (!response.ok || envelope.code !== 0) {
      throw new AccountFailure(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not-found' : response.status === 429 ? 'rate-limited' : response.status >= 500 ? 'unavailable' : 'invalid-response')
    }
    return envelope.data
  }

  private drop() {
    this.generation++
    this.access = null
    this.refresh = null
    this.refreshing = undefined
    this.options.vault.clear()
  }
  private async revoke(token: string) { await this.request('/revoke', { body: { client_id: DESKTOP_CLIENT, token } }) }
  private async exchange(grant: object, epoch: number, signal?: AbortSignal) {
    // Once a grant is sent, consume the response even if cancelled so an issued
    // session can be revoked instead of becoming an orphan.
    const data = record(await this.request('/token', { body: { client_id: DESKTOP_CLIENT, ...grant } }))
    if (data.token_type !== 'Bearer' || data.scope !== SCOPE || typeof data.access_token !== 'string' || !DESKTOP_ACCESS.test(data.access_token) ||
      typeof data.refresh_token !== 'string' || !DESKTOP_REFRESH.test(data.refresh_token) || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new AccountFailure('invalid-response')
    if (epoch !== this.generation || signal?.aborted) {
      await this.revoke(data.refresh_token).catch(() => {})
      throw signal?.reason ?? new AccountFailure('cancelled')
    }
    this.refresh = data.refresh_token
    this.access = { token: data.access_token, expires: this.now() + Math.min(900, data.expires_in) * 1000 }
    this.options.vault.save(this.refresh)
  }
  private async accessToken(epoch: number) {
    this.assertCurrent(epoch)
    if (this.access && this.access.expires > this.now() + 5000) return this.access.token
    if (!this.refresh) throw new AccountFailure('unauthorized')
    if (!this.refreshing) {
      this.refreshing = this.exchange({ grant_type: 'refresh_token', refresh_token: this.refresh }, epoch).catch(error => {
        if (epoch === this.generation && error instanceof AccountFailure && error.code === 'unauthorized') this.drop()
        throw error
      }).finally(() => { if (epoch === this.generation) this.refreshing = undefined })
    }
    await this.refreshing
    this.assertCurrent(epoch)
    if (!this.access) throw new AccountFailure('unauthorized')
    return this.access.token
  }
  private async authorized(path: string, epoch: number, body?: object): Promise<unknown> {
    for (const retry of [false, true]) {
      const token = await this.accessToken(epoch)
      this.assertCurrent(epoch)
      try {
        const data = await this.request(path, { token, body })
        this.assertCurrent(epoch)
        return data
      } catch (error) {
        this.assertCurrent(epoch)
        if (!(error instanceof AccountFailure) || error.code !== 'unauthorized') throw error
        if (retry) { this.drop(); throw error }
        if (this.access?.token === token) this.access = null
      }
    }
    throw new AccountFailure('unauthorized')
  }
  private async profile(epoch: number): Promise<AccountProfile> {
    const user = record(record(await this.authorized('/me', epoch)).user)
    const email = text(user.email)
    return { id: id(user.id), displayName: text(user.username) || email, ...(email ? { email } : {}) }
  }
  getStatus() {
    return result<AccountStatus>(async () => {
      if (this.pending) return { status: 'authorizing', authenticated: false }
      if (!this.refresh) return { status: 'signed-out', authenticated: false }
      const epoch = this.generation
      const profile = await this.profile(epoch)
      const unread = parseItems(await this.authorized('/announcements?unread_only=true', epoch))
      return { status: 'signed-in', authenticated: true, profile, unreadCount: unread.length }
    })
  }
  beginLogin() {
    return result(async () => {
      if (this.pending || this.refresh) throw new AccountFailure('unavailable')
      const flow = new AbortController()
      this.pending = flow
      const epoch = this.generation
      const timer = setTimeout(() => flow.abort(new AccountFailure('timeout')), this.options.loginTimeoutMs ?? 300_000)
      try {
        await this.request('/me', { probe: true, signal: flow.signal })
        const { code, verifier, redirectUri } = await authorizeInBrowser(this.options.open, flow.signal)
        flow.signal.throwIfAborted()
        await this.exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, epoch, flow.signal)
      } finally {
        clearTimeout(timer)
        if (this.pending === flow) this.pending = undefined
      }
    })
  }
  cancelLogin() {
    return result(async () => { this.pending?.abort(new AccountFailure('cancelled')) })
  }
  signOut() {
    return result(async () => {
      this.pending?.abort(new AccountFailure('cancelled'))
      const token = this.refresh
      try { this.drop() } finally { if (token) await this.revoke(token) }
    })
  }
  getProfile() { return result(() => this.profile(this.generation)) }
  listAnnouncements(input?: AccountAnnouncementListInput) {
    return result(async () => {
      const items = parseItems(await this.authorized('/announcements?unread_only=false', this.generation))
      const start = Number(input?.cursor ?? 0)
      const end = start + (input?.limit ?? items.length)
      return { items: items.slice(start, end), ...(end < items.length ? { nextCursor: String(end) } : {}) }
    })
  }
  markAnnouncementRead({ id }: AccountAnnouncementReadInput) {
    return result(async () => { await this.authorized(`/announcements/${id}/read`, this.generation, {}) })
  }
  markAllAnnouncementsRead() {
    return result(async () => {
      const epoch = this.generation
      for (const item of parseItems(await this.authorized('/announcements?unread_only=true', epoch))) {
        await this.authorized(`/announcements/${item.id}/read`, epoch, {})
      }
    })
  }
}
