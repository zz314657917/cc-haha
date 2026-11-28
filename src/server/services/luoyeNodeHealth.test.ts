import { expect, test } from 'bun:test'
import { checkLuoyeNode } from './luoyeNodeHealth.js'

const settings = { aiRequestTimeoutMs: 30000, proxy: { mode: 'direct' as const, url: '' } }
for (const [region, host] of [['hk', 'cn-api.3zapi.com'], ['us', 'ai.3zapi.com']] as const) {
  test(`${region} checks only its fixed catalog without following redirects`, async () => {
    const requests: string[] = []
    const result = await checkLuoyeNode(region, 'fixture-secret', settings, (async (url, init) => {
      requests.push(String(url))
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-secret')
      return new Response('private upstream detail', { status: 307, headers: { Location: 'https://other.invalid/path' } })
    }) as typeof fetch)
    expect(requests).toEqual([`https://${host}/v1/models`])
    expect(result).toMatchObject({ region, httpStatus: 307, status: 'redirect' })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|upstream detail|other.invalid/)
  })
}
for (const [code, key, status] of [[401, '', 'authRequired'], [403, 'fixture', 'denied'], [200, '', 'responded'], [429, '', 'limited'], [500, '', 'httpError']] as const) {
  test(`reports ${code} as ${status}`, async () => {
    const result = await checkLuoyeNode('hk', key, settings, (async (_url, init) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(Boolean(key))
      return new Response(null, { status: code })
    }) as typeof fetch)
    expect(result).toMatchObject({ httpStatus: code, status })
  })
}
for (const [code, status] of [['EAI_AGAIN', 'dns'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['ETIMEDOUT', 'timeout'], ['ECONNRESET', 'network']]) {
  test(`classifies ${code} without echoing transport errors`, async () => {
    const result = await checkLuoyeNode('us', '', settings, (async () => { throw new Error('private', { cause: { code } }) }) as typeof fetch)
    expect(result.status).toBe(status)
    expect(result).not.toHaveProperty('httpStatus')
    expect(JSON.stringify(result)).not.toContain('private')
  })
}
