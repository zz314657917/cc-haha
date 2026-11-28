import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from './networkSettings.js'

export type Region = 'hk' | 'us'

function networkFailure(error: unknown) {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const { code, name, cause } = error as { code?: string; name?: string; cause?: unknown }
    if (name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout'
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
    if (typeof code === 'string' && /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_ISSUER_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(code)) return 'tls'
    error = cause
  }
  return 'network'
}

export async function checkLuoyeNode(region: Region, key: string, settings: Awaited<ReturnType<typeof loadNetworkSettings>>, transport = fetch) {
  const base = PROVIDER_PRESETS.find(p => p.id === 'luoyeai')?.regionalEndpoints?.find(e => e.region === region)?.baseUrl
  if (!base || !base.startsWith('https://')) throw new Error('Invalid built-in endpoint')
  const endpoint = `${base.replace(/\/+$/, '')}/models`
  const start = performance.now()
  const elapsed = () => Math.round(performance.now() - start)
  try {
    const response = await transport(endpoint, {
      ...getNetworkProxyFetchOptions(settings, endpoint), method: 'GET', redirect: 'manual',
      headers: { Accept: 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
      signal: AbortSignal.timeout(8000),
    })
    const httpStatus = response.status
    const latencyMs = elapsed()
    // Measure time to response headers only. Do not read or echo catalog/error contents.
    void response.body?.cancel().catch(() => {})
    const status = response.ok ? 'responded' : httpStatus === 401 || httpStatus === 403
      ? (key ? 'denied' : 'authRequired') : httpStatus === 429 ? 'limited' : httpStatus >= 300 && httpStatus < 400 ? 'redirect' : 'httpError'
    return { region, status, latencyMs, httpStatus }
  } catch (error) {
    return { region, status: networkFailure(error), latencyMs: elapsed() }
  }
}
