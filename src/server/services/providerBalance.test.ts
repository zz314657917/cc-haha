import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { handleProvidersApi } from '../api/providers.js'
import { ProviderService } from './providerService.js'
import {
  buildUsageUrl,
  fetchProviderBalance,
  parseUsageResponse,
  supportsProviderBalance,
} from './providerBalance.js'
import type { SavedProvider } from '../types/provider.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-balance-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function provider(overrides: Partial<SavedProvider> = {}): SavedProvider {
  return {
    id: 'p1', presetId: 'luoyeai', name: '落叶AI', apiKey: 'fake-key',
    baseUrl: 'https://cn-api.3zapi.com', apiFormat: 'openai_responses', runtimeKind: 'anthropic_compatible',
    models: { main: 'claude-opus-5-5', haiku: 'x', sonnet: 'x', opus: 'x' },
    ...overrides,
  }
}

function startFakeSub2Api(respond: (req: Request) => Response) {
  const seen: Array<{ path: string; auth: string | null }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') })
      return respond(req)
    },
  })
  return { server, seen, origin: `http://127.0.0.1:${server.port}` }
}

describe('supportsProviderBalance', () => {
  test('covers the preset and providers hand-pointed at either 落叶AI node', () => {
    expect(supportsProviderBalance({ presetId: 'luoyeai', baseUrl: 'http://127.0.0.1:1' })).toBe(true)
    expect(supportsProviderBalance({ presetId: 'custom', baseUrl: 'https://cn-api.3zapi.com/v1' })).toBe(true)
    expect(supportsProviderBalance({ presetId: 'custom', baseUrl: 'https://AI.3zapi.com' })).toBe(true)
    expect(supportsProviderBalance({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(false)
    expect(supportsProviderBalance({ presetId: 'custom', baseUrl: 'not a url' })).toBe(false)
  })
})

describe('buildUsageUrl', () => {
  test('accepts gateway roots and OpenAI-style /v1 bases', () => {
    expect(buildUsageUrl('https://cn-api.3zapi.com')).toBe('https://cn-api.3zapi.com/v1/usage')
    expect(buildUsageUrl('https://cn-api.3zapi.com/')).toBe('https://cn-api.3zapi.com/v1/usage')
    expect(buildUsageUrl('https://cn-api.3zapi.com/v1/')).toBe('https://cn-api.3zapi.com/v1/usage')
  })
})

describe('parseUsageResponse', () => {
  test('wallet balance mode', () => {
    expect(parseUsageResponse({
      mode: 'unrestricted', isValid: true, planName: '钱包余额', remaining: 12.5, balance: 12.5, unit: 'USD',
      usage: { today: { actual_cost: 0.42 } },
    })).toEqual({ ok: true, kind: 'balance', remaining: 12.5, unit: 'USD', todayCost: 0.42 })
  })

  test('per-key quota mode', () => {
    expect(parseUsageResponse({
      mode: 'quota_limited', isValid: true, status: 'active',
      quota: { limit: 10, used: 6.8, remaining: 3.2, unit: 'USD' }, remaining: 3.2, unit: 'USD',
    })).toEqual({ ok: true, kind: 'quota', remaining: 3.2, limit: 10, unit: 'USD' })
  })

  test('quota mode with only rate limits has no total remaining', () => {
    expect(parseUsageResponse({ mode: 'quota_limited', isValid: true, rate_limits: [] }))
      .toEqual({ ok: true, kind: 'quota', remaining: null, unit: 'USD' })
  })

  test('subscription mode, with and without the live subscription row', () => {
    expect(parseUsageResponse({
      mode: 'unrestricted', isValid: true, planName: 'Pro', unit: 'USD', remaining: 4, subscription: {},
    })).toEqual({ ok: true, kind: 'subscription', remaining: 4, unit: 'USD', planName: 'Pro' })
    expect(parseUsageResponse({ mode: 'unrestricted', isValid: true, planName: 'Pro', unit: 'USD' }))
      .toEqual({ ok: true, kind: 'subscription', remaining: null, unit: 'USD', planName: 'Pro' })
  })

  test('rejects shapes without a balance', () => {
    expect(parseUsageResponse({ mode: 'unrestricted' })).toMatchObject({ ok: false, errorCode: 'unknown' })
    expect(parseUsageResponse(null)).toMatchObject({ ok: false, errorCode: 'unknown' })
  })
})

describe('fetchProviderBalance', () => {
  test('reads /v1/usage with the saved key as a bearer token', async () => {
    const fake = startFakeSub2Api(() => Response.json({ mode: 'unrestricted', balance: 7.25, remaining: 7.25, unit: 'USD' }))
    try {
      const result = await fetchProviderBalance(provider({ baseUrl: `${fake.origin}/v1` }))
      expect(result).toEqual({ ok: true, kind: 'balance', remaining: 7.25, unit: 'USD' })
      expect(fake.seen).toEqual([{ path: '/v1/usage', auth: 'Bearer fake-key' }])
    } finally {
      fake.server.stop(true)
    }
  })

  test('maps a rejected key to auth-failed', async () => {
    const fake = startFakeSub2Api(() => Response.json({ code: 'INVALID_API_KEY' }, { status: 401 }))
    try {
      expect(await fetchProviderBalance(provider({ baseUrl: fake.origin })))
        .toMatchObject({ ok: false, errorCode: 'auth-failed' })
    } finally {
      fake.server.stop(true)
    }
  })

  test('never contacts a provider that is not 落叶AI', async () => {
    const fake = startFakeSub2Api(() => Response.json({ balance: 1 }))
    try {
      const result = await fetchProviderBalance(provider({ presetId: 'custom', baseUrl: fake.origin }))
      expect(result).toMatchObject({ ok: false, errorCode: 'unsupported' })
      expect(fake.seen).toHaveLength(0)
    } finally {
      fake.server.stop(true)
    }
  })
})

describe('GET /api/providers/:id/balance', () => {
  test('returns the saved provider balance without exposing the key', async () => {
    const fake = startFakeSub2Api(() => Response.json({ mode: 'unrestricted', balance: 3, unit: 'USD' }))
    try {
      const saved = await new ProviderService().addProvider({
        presetId: 'luoyeai', name: '落叶AI', apiKey: 'fake-key', baseUrl: fake.origin,
        apiFormat: 'openai_responses', runtimeKind: 'anthropic_compatible',
        models: { main: 'claude-opus-5-5', haiku: 'x', sonnet: 'x', opus: 'x' },
      })
      const url = new URL(`http://localhost:3456/api/providers/${saved.id}/balance`)
      const response = await handleProvidersApi(new Request(url, { method: 'GET' }), url, url.pathname.split('/').filter(Boolean))
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual({ balance: { ok: true, kind: 'balance', remaining: 3, unit: 'USD' } })
      expect(text).not.toContain('fake-key')
    } finally {
      fake.server.stop(true)
    }
  })

  test('404s an unknown provider', async () => {
    const url = new URL('http://localhost:3456/api/providers/missing/balance')
    const response = await handleProvidersApi(new Request(url), url, url.pathname.split('/').filter(Boolean))
    expect(response.status).toBe(404)
  })
})
