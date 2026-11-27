import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment'
import { DesktopModelRelay } from '../../../desktop/electron/services/accountModel'
import { consumeDesktopModelLaunchEnv } from './desktopModelRelay'
import { ProviderService } from './providerService'
import { handleProvidersApi } from '../api/providers'
import { handleProxyRequest } from '../proxy/handler'

test('account preset sends GPT/Claude catalog choices through the real local translator and rejects an empty catalog', async () => {
  const previous = { ...process.env }, home = await mkdtemp(join(tmpdir(), 'luoye-protocol-'))
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, createSandboxedTestEnvironment(home, { CC_HAHA_LOCAL_ACCESS_TOKEN: 'fixture-control' }, previous))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const url = new URL(req.url)
    return handleProvidersApi(req, url, url.pathname.split('/').filter(Boolean))
  } })
  const service = new ProviderService()
  let stored: string | null = null, catalog: string[] = [], deny = false
  const fixtureKey = 'placeholder-model-credential'
  const sends: string[] = []
  const relay = new DesktopModelRelay({ read: () => stored, save: v => { stored = v }, clear: () => { stored = null } },
    () => ({ serverUrl: `http://127.0.0.1:${server.port}`, token: 'fixture-control' }), async (url, init) => {
      expect(new URL(url).origin).toBe('https://ai.3zapi.com'); expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('Authorization') === `Bearer ${fixtureKey}`).toBe(true)
      if (url.endsWith('/v1/models')) return Response.json({ data: catalog.map(id => ({ id })) })
      sends.push(new URL(url).pathname)
      const body = await new Response(init.body).json()
      expect(body.model).toBe(catalog[0])
      if (deny) return new Response('sensitive upstream detail', { status: 403 })
      return body.model.startsWith('gpt-') ? Response.json({ id: 'r1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture reply' }] }] })
        : Response.json({ id: 'm1', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'fixture reply' }] })
    })
  try {
    Object.assign(process.env, await relay.serverEnv()); consumeDesktopModelLaunchEnv()
    for (const model of ['gpt-fixture', 'claude-fixture']) {
      catalog = [model]; await relay.install('42', fixtureKey)
      const provider = await service.getProvider('luoye-account-42')
      expect(provider.models.main).toBe(model); expect(provider.apiKey).toBe('')
      const env = await service.getProviderRuntimeEnv(provider.id)
      const url = new URL(`${env.ANTHROPIC_BASE_URL}/v1/messages`)
      const call = () => handleProxyRequest(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: env.ANTHROPIC_MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'local fixture' }] }) }), url)
      deny = false; const reply = await call(); expect(reply.status).toBe(200); expect((await reply.json()).content[0].text).toBe('fixture reply')
      deny = true; const rejection = await call(); expect(rejection.status).toBe(403); expect(await rejection.text()).not.toContain('sensitive upstream detail')
    }
    expect(sends).toEqual(['/v1/responses', '/v1/responses', '/v1/messages', '/v1/messages'])
    const manual = await service.addProvider({ presetId: 'custom', name: 'manual fixture', apiKey: 'user-entered-placeholder', baseUrl: 'https://fixture.invalid', models: { main: 'm', sonnet: 'm', opus: 'm', haiku: 'm' } })
    await service.activateProvider(manual.id)
    catalog = []; await expect(relay.install('42', fixtureKey)).rejects.toThrow(); expect(stored).toBeNull()
    expect(await service.listProviders()).toMatchObject({ activeId: manual.id, providers: [manual] })
  } finally {
    relay.close(); await server.stop(true); consumeDesktopModelLaunchEnv()
    for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, previous)
    await rm(home, { recursive: true, force: true, maxRetries: 3 })
  }
})
