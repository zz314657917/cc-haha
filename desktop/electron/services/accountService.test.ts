// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AccountService } from './accountService'

const code = `dsc_${'c'.repeat(43)}`
const pair = (version: number) => ({ access_token: `dsa_${String(version).repeat(43)}`, refresh_token: `dsr_${String(version).repeat(43)}`, token_type: 'Bearer', expires_in: 900, refresh_expires_in: 2592000, scope: 'profile announcements:read announcements:read-state' })
const ok = (data: unknown) => Response.json({ code: 0, message: 'success', data })
const denied = () => Response.json({ code: 401, reason: 'desktop_unauthorized' }, { status: 401 })
function fixture({ saved = null as string | null, timeout = 5_000 } = {}) {
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
      case '/token': return ok(pair(++version))
      case '/revoke': return ok({ revoked: true })
      case '/announcements': return ok([{ id: 5, title: 'Update', content: 'Message', created_at: '2026-01-01', internal: 'secret' }])
      case '/announcements/5/read': return ok({ message: 'ok' })
      default: throw new Error('Unexpected mock request')
    }
  })
  const open = vi.fn(async (url: string) => { launch(new URL(url)) })
  const service = new AccountService({ vault, open, fetch: transport, loginTimeoutMs: timeout, now: () => time })
  return { service, launched, open, vault, transport, expire: () => { time += 901_000 } }
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
  it('remains signed out even if server revocation is offline', async () => {
    const f = fixture({ saved: pair(1).refresh_token })
    f.transport.mockRejectedValueOnce(new Error('offline'))
    expect(await f.service.signOut()).toMatchObject({ error: { code: 'network' } })
    expect(await f.service.getStatus()).toMatchObject({ data: { authenticated: false } })
    expect(f.vault.clear).toHaveBeenCalled()
  })
})
