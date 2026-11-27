// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AccountService } from './accountService'

const code = `dsc_${'c'.repeat(43)}`
const pair = (version: number) => ({ access_token: `dsa_${String(version).repeat(43)}`, refresh_token: `dsr_${String(version).repeat(43)}`, token_type: 'Bearer', expires_in: 900, refresh_expires_in: 2592000, scope: 'profile announcements:read announcements:read-state' })
const ok = (data: unknown) => Response.json({ code: 0, message: 'success', data })
const denied = () => Response.json({ code: 401, reason: 'desktop_unauthorized' }, { status: 401 })
const fixtureKey = 'test-key-not-a-real-credential'
function fixture({ saved = null as string | null, timeout = 5_000, models = false, grant = false } = {}) {
  const model = { install: vi.fn(async (_user: string, _key: string) => {}), clear: vi.fn(async () => {}) }
  let claim: () => Promise<Response> = async () => ok({ key: fixtureKey })
  let time = 1000
  const vault = { read: () => saved, save: vi.fn((value: string) => { saved = value }), clear: vi.fn(() => { saved = null }) }
  let launch!: (url: URL) => void
  const launched = new Promise<URL>(resolve => { launch = resolve })
  let version = 0
  const transport = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const route = new URL(url)
    expect(route.origin).toBe('https://ai.3zapi.com')
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' })
    const bearer = new Headers(init.headers).get('Authorization')
    switch (route.pathname.replace('/api/v1/desktop', '')) {
      case '/me': return bearer ? ok({ user: { id: 42, username: 'Sam', email: 'sam@example.test', api_key: 'never return me' } }) : denied()
      case '/model-key':
        expect(init.method).toBe('POST'); expect(init.body).toBeUndefined(); expect(route.search).toBe('')
        expect(bearer).toBe(`Bearer ${pair(version).access_token}`)
        return claim()
      case '/token': { const p = pair(++version); return ok({ ...p, scope: p.scope + (grant ? ' account-summary:read model-key:provision' : '') }) }
      case '/revoke': return ok({ revoked: true })
      case '/announcements': return ok([{ id: 5, title: 'Update', content: 'Message', created_at: '2026-01-01', internal: 'secret' }])
      case '/announcements/5/read': return ok({ message: 'ok' })
      default: throw new Error('Unexpected mock request')
    }
  })
  const open = vi.fn(async (url: string) => { launch(new URL(url)) })
  const service = new AccountService({ vault, open, fetch: transport, loginTimeoutMs: timeout, now: () => time, ...(models && { model }) })
  return { service, launched, open, vault, transport, model, setClaim: (next: typeof claim) => { claim = next }, expire: () => { time += 901_000 } }
}
function callback(authorize: URL) {
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
  expect(redirect.hostname).toBe('127.0.0.1')
  redirect.search = new URLSearchParams({ code, state: authorize.searchParams.get('state')! }).toString()
  return redirect
}
describe('LuoyeAI account login and limited session', () => {
  it('binds before launch, rejects a stray state and consumes the correct callback once with S256', async () => {
    const f = fixture()
    const login = f.service.beginLogin()
    const url = await f.launched
    expect(url.origin + url.pathname).toBe('https://ai.3zapi.com/desktop/authorize')
    expect(url.searchParams.getAll('scope')).toEqual(['account-summary:read'])
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const correct = callback(url)
    const wrong = new URL(correct)
    wrong.searchParams.set('state', 'incorrect')
    expect((await fetch(wrong)).status).toBe(400)
    expect(f.vault.save).not.toHaveBeenCalled()
    expect(await f.service.getStatus()).toMatchObject({ data: { status: 'authorizing' } })
    expect((await fetch(correct)).status).toBe(200)
    expect(await login).toEqual({ ok: true, data: undefined })
    await expect(fetch(correct)).rejects.toThrow()
    const body = JSON.parse(String(f.transport.mock.calls[1]?.[1].body))
    expect(body).toEqual({ client_id: 'luoyeai-desktop', grant_type: 'authorization_code', code, redirect_uri: url.searchParams.get('redirect_uri'), code_verifier: expect.any(String) })
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
    expect(f.vault.save).toHaveBeenCalledWith(pair(1).refresh_token)
    expect(await f.service.getStatus()).toEqual({ ok: true, data: { authenticated: true, status: 'signed-in', unreadCount: 1, profile: { id: '42', displayName: 'Sam', email: 'sam@example.test' } } })
    expect(await f.service.listAnnouncements()).toEqual({ ok: true, data: { items: [{ id: '5', title: 'Update', body: 'Message', publishedAt: '2026-01-01' }] } })
    expect(await f.service.markAllAnnouncementsRead()).toMatchObject({ ok: true })
    expect(f.transport.mock.calls.at(-1)?.[0]).toMatch(/\/announcements\/5\/read$/)
    f.expire()
    await Promise.all([f.service.getProfile(), f.service.getProfile()])
    expect(f.vault.save.mock.calls).toEqual([[pair(1).refresh_token], [pair(2).refresh_token]])
    expect(await f.service.signOut()).toEqual({ ok: true, data: undefined })
    expect(JSON.parse(String(f.transport.mock.calls.at(-1)?.[1].body))).toEqual({ client_id: 'luoyeai-desktop', token: pair(2).refresh_token })
    expect(f.vault.clear).toHaveBeenCalled()
    expect(await f.service.getStatus()).toMatchObject({ data: { status: 'signed-out' } })
  })
  it.each([true, false])('requests both scopes on Windows and only provisions if granted (%s)', async grant => {
    const f = fixture({ models: true, grant })
    const login = f.service.beginLogin()
    const url = await f.launched
    expect(url.searchParams.get('scope')).toBe('account-summary:read model-key:provision')
    await fetch(callback(url)); expect(await login).toMatchObject({ ok: true })
    const status = await f.service.getStatus()
    expect(status).toMatchObject({ ok: true, data: { authenticated: true, ...(grant && { modelSetup: 'ready' }) } })
    expect(JSON.stringify(status).includes(fixtureKey)).toBe(false)
    expect(f.model.install).toHaveBeenCalledTimes(grant ? 1 : 0)
    expect(f.transport.mock.calls.filter(([url]) => url.endsWith('/model-key'))).toHaveLength(grant ? 1 : 0)
    if (grant) expect(f.model.install).toHaveBeenCalledWith('42', fixtureKey)
  })
  it('retains login on claim failure and retries without another authorization', async () => {
    const f = fixture({ models: true, grant: true, saved: pair(1).refresh_token })
    f.setClaim(async () => denied())
    expect(await f.service.getStatus()).toMatchObject({ data: { authenticated: true, modelSetup: 'failed' } })
    f.setClaim(async () => ok({ key: fixtureKey }))
    expect(await f.service.getStatus()).toMatchObject({ data: { authenticated: true, modelSetup: 'ready' } })
    expect(f.vault.clear).not.toHaveBeenCalled()
  })
  it('discards a key delivered after sign-out', async () => {
    const f = fixture({ models: true, grant: true, saved: pair(1).refresh_token })
    let finish!: (r: Response) => void
    f.setClaim(() => new Promise(r => { finish = r }))
    const pending = f.service.getStatus(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await f.service.signOut(); finish(ok({ key: fixtureKey }))
    expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
    expect(f.model.install).not.toHaveBeenCalled()
    expect(f.model.clear).toHaveBeenCalled()
  })
  it.each(['timeout', 'cancelled'] as const)('closes the loopback listener on %s', async reason => {
    const f = fixture({ timeout: reason === 'timeout' ? 120 : 5000 })
    const login = f.service.beginLogin()
    const url = await f.launched
    if (reason === 'cancelled') await f.service.cancelLogin()
    expect(await login).toMatchObject({ ok: false, error: { code: reason } })
    await expect(fetch(callback(url))).rejects.toThrow()
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it('detects an old website without opening a browser or disclosing a saved credential', async () => {
    const f = fixture({ saved: 'fixture-website-jwt' })
    f.transport.mockResolvedValueOnce(new Response('<html>old app</html>'))
    expect(await f.service.beginLogin()).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(f.open).not.toHaveBeenCalled()
    expect(new Headers(f.transport.mock.calls[0]?.[1].headers).has('Authorization')).toBe(false)
  })
  it('clears revoked refresh grants but keeps them on transient network failures', async () => {
    const f = fixture({ saved: pair(2).refresh_token })
    f.transport.mockRejectedValueOnce(new Error('sensitive detail'))
    expect(await f.service.getStatus()).toEqual({ ok: false, error: { code: 'network', message: 'Cannot reach the account service.' } })
    expect(f.vault.clear).not.toHaveBeenCalled()
    f.transport.mockResolvedValueOnce(denied())
    expect(await f.service.getProfile()).toMatchObject({ error: { code: 'unauthorized' } })
    expect(f.vault.clear).toHaveBeenCalled()
  })
  it('does not adopt a late refresh after signout; revokes the rotated credential too', async () => {
    const f = fixture({ saved: pair(2).refresh_token })
    let complete!: (response: Response) => void
    f.transport.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const profile = f.service.getProfile()
    await f.service.signOut()
    complete(ok(pair(3)))
    expect(await profile).toMatchObject({ error: { code: 'cancelled' } })
    expect(f.vault.save).not.toHaveBeenCalled()
    expect(JSON.parse(String(f.transport.mock.calls.at(-1)?.[1].body)).token).toBe(pair(3).refresh_token)
  })
  it.each([
    'announcements:read-state profile announcements:read',
    'announcements:read account-summary:read profile announcements:read-state',
  ])('accepts the supported grant set in any order: %s', async scope => {
    const f = fixture({ saved: pair(2).refresh_token })
    f.transport.mockResolvedValueOnce(ok({ ...pair(1), scope }))
    expect(await f.service.getStatus()).toMatchObject({ ok: true, data: { authenticated: true, unreadCount: 1 } })
  })
  it.each([
    undefined, '', 'account-summary:read', 'announcements:read profile account-summary:read',
    `${pair(1).scope} admin`, `${pair(1).scope} account-summary:read admin`,
  ])('rejects missing or unknown token grants without saving the pair: %s', async scope => {
    const f = fixture({ saved: pair(2).refresh_token })
    f.transport.mockResolvedValueOnce(ok({ ...pair(1), scope }))
    expect(await f.service.getStatus()).toMatchObject({ ok: false, error: { code: 'invalid-response' } })
    expect(f.vault.save).not.toHaveBeenCalled()
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it('keeps a legacy session usable when only the summary lacks scope', async () => {
    const f = fixture({ saved: pair(2).refresh_token })
    await f.service.getStatus()
    const forbidden = (reason: string) => Response.json({ code: 403, reason }, { status: 403 })
    f.transport.mockClear().mockResolvedValueOnce(forbidden('insufficient_scope'))
    expect(await f.service.getSummary()).toMatchObject({ ok: false, error: { code: 'insufficient-scope' } })
    f.transport.mockResolvedValueOnce(forbidden('other'))
    expect(await f.service.getSummary()).toMatchObject({ error: { code: 'invalid-response' } })
    f.transport.mockResolvedValueOnce(forbidden('insufficient_scope'))
    expect(await f.service.getProfile()).toMatchObject({ error: { code: 'invalid-response' } })
    expect(await f.service.getStatus()).toMatchObject({ data: { authenticated: true, unreadCount: 1 } })
    expect(await f.service.markAnnouncementRead({ id: '5' })).toMatchObject({ ok: true })
    expect(f.transport.mock.calls.every(([, init]) => new Headers(init.headers).get('Authorization') === `Bearer ${pair(1).access_token}`)).toBe(true)
    expect(f.vault.clear).not.toHaveBeenCalled()
  })
  it('loads only the fixed bearer summary, keeping zero and unavailable fields distinct', async () => {
    const guest = fixture()
    expect(await guest.service.getSummary()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(guest.transport).not.toHaveBeenCalled()
    const f = fixture({ saved: pair(2).refresh_token })
    f.transport.mockResolvedValueOnce(ok({ ...pair(1), scope: `account-summary:read ${pair(1).scope}` }))
    await f.service.getStatus()
    f.transport.mockClear().mockResolvedValueOnce(ok({ user_id: 42, points: 0, concurrency_current: 0, concurrency_limit: null, today_tokens: 'unknown', today_requests: 7, api_key: 'discard' }))
    expect(await f.service.getSummary()).toEqual({ ok: true, data: { userId: '42', points: 0, concurrencyCurrent: 0, concurrencyLimit: null, todayTokens: null, todayRequests: 7 } })
    expect(f.transport.mock.calls).toEqual([['https://ai.3zapi.com/api/v1/desktop/summary', expect.objectContaining({ method: 'GET', cache: 'no-store', headers: { Accept: 'application/json', Authorization: `Bearer ${pair(1).access_token}` } })]])
    f.transport.mockResolvedValueOnce(ok({ points: 5 }))
    expect(await f.service.getSummary()).toMatchObject({ ok: false, error: { code: 'invalid-response' } })
    expect(f.vault.save.mock.calls).toEqual([[pair(1).refresh_token]])
  })
  it('rejects summary data received after signout', async () => {
    const f = fixture({ saved: pair(2).refresh_token })
    await f.service.getProfile()
    let complete!: (response: Response) => void
    f.transport.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = f.service.getSummary()
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    await f.service.signOut()
    complete(ok({ user_id: 42, points: 12345 }))
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
  it('remains signed out even if server revocation is offline', async () => {
    const f = fixture({ saved: pair(1).refresh_token })
    f.transport.mockRejectedValueOnce(new Error('offline'))
    expect(await f.service.signOut()).toMatchObject({ error: { code: 'network' } })
    expect(await f.service.getStatus()).toMatchObject({ data: { authenticated: false } })
    expect(f.vault.clear).toHaveBeenCalled()
  })
})
