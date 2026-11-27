// @vitest-environment node
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { DesktopModelRelay } from './accountModel'

describe('desktop main-process model transport', () => {
  it('sends only a typed model request to the fixed origin, rejects web access and retires account routes immediately', async () => {
    const key = 'unit-test-placeholder-not-a-credential'
    const controls: { userId: string | null; revision: number }[] = []
    let secret = ''
    const sidecar = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      if (req.headers.authorization !== 'Bearer fixture-sidecar' || req.url !== '/api/providers/desktop-account-sync' || req.headers['x-luoye-model-signature'] !== createHmac('sha256', secret).update(body).digest('hex') || body.includes(key)) { res.writeHead(403).end(); return }
      controls.push(JSON.parse(body)); res.writeHead(200).end()
    })
    await new Promise<void>(r => sidecar.listen(0, '127.0.0.1', r))
    const address = sidecar.address(); if (!address || typeof address === 'string') throw new Error('fixture unavailable')
    let stored: string | null = null
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      if (url === 'https://ai.3zapi.com/v1/models') {
        expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
        return Response.json({ data: [{ id: 'gpt-test-model' }] })
      }
      expect(url).toBe('https://ai.3zapi.com/v1/messages')
      expect(init).toMatchObject({ redirect: 'error', method: 'POST', credentials: 'omit' })
      expect(new Headers(init.headers).get('Authorization') === `Bearer ${key}`).toBe(true)
      expect(await new Response(init.body).json()).toMatchObject({ model: 'fixture-model' })
      return Response.json({ content: [{ type: 'text', text: 'fixture reply' }] })
    })
    const relay = new DesktopModelRelay({ read: () => stored, save: v => { stored = v }, clear: () => { stored = null } }, () => ({ serverUrl: `http://127.0.0.1:${address.port}`, token: 'fixture-sidecar' }), upstream)
    try {
      const env = await relay.serverEnv(); secret = env.LUOYE_MODEL_RELAY_TOKEN!
      await relay.install('42', key)
      const port = env.LUOYE_MODEL_RELAY_PORT
      const send = (id: string, path: string, origin?: string, token = 'missing') => fetch(`http://127.0.0.1:${port}/luoye-account-${id}/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(origin && { Origin: origin }) }, body: JSON.stringify({ model: 'fixture-model' }) })
      const proof = createHmac('sha256', secret).update(`model:luoye-account-42:${controls[0]?.revision}`).digest('base64url')
      expect((await send('42', 'messages')).status).toBe(403)
      expect((await send('42', 'messages', 'https://fixture.invalid', proof)).status).toBe(403)
      expect((await send('42', 'messages?url=https://fixture.invalid', undefined, proof)).status).toBe(403)
      expect((await send('42', 'messages', undefined, proof)).status).toBe(200)
      await relay.clear(); expect(stored).toBeNull()
      await relay.install('24', key)
      expect((await send('42', 'messages', undefined, proof)).status).toBe(403)
      expect((await send('24', 'messages', undefined, proof)).status).toBe(403)
      expect(upstream).toHaveBeenCalledTimes(3) // two catalogs and one inference
      expect(controls.map(c => c.userId)).toEqual(['42', null, '24'])
    } finally { relay.close(); sidecar.close(); sidecar.closeAllConnections() }
  })
})
