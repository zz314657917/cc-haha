/**
 * Balance lookup for 落叶AI (a sub2api gateway). sub2api answers
 * `GET /v1/usage` for any API key without billing the call, in one of three
 * shapes: wallet balance, per-key quota, or a subscription plan. This module
 * normalizes those into one summary the desktop can render.
 */

import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
  resolveProviderNetworkSettings,
} from './networkSettings.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import type { SavedProvider } from '../types/provider.js'

export const LUOYEAI_PRESET_ID = 'luoyeai'
const FETCH_TIMEOUT_MS = 10_000

export type ProviderBalance =
  | {
      ok: true
      kind: 'balance' | 'quota' | 'subscription'
      remaining: number | null
      limit?: number
      unit: string
      planName?: string
      todayCost?: number
    }
  | {
      ok: false
      errorCode: 'auth-failed' | 'unsupported' | 'network' | 'unknown'
      message: string
    }

function luoyeAiHosts(): Set<string> {
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === LUOYEAI_PRESET_ID)
  const urls = [preset?.baseUrl, ...(preset?.regionalEndpoints ?? []).map((endpoint) => endpoint.baseUrl)]
  const hosts = new Set<string>()
  for (const url of urls) {
    if (!url) continue
    try { hosts.add(new URL(url).host.toLowerCase()) } catch { /* preset URLs are static */ }
  }
  return hosts
}

/** Only 落叶AI gets a balance probe, so no other gateway ever sees the key on an extra route. */
export function supportsProviderBalance(provider: Pick<SavedProvider, 'presetId' | 'baseUrl'>): boolean {
  if (provider.presetId === LUOYEAI_PRESET_ID) return true
  try {
    return luoyeAiHosts().has(new URL(provider.baseUrl).host.toLowerCase())
  } catch {
    return false
  }
}

/** `https://host`, `https://host/` and `https://host/v1` all serve usage at `https://host/v1/usage`. */
export function buildUsageUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
  return `${base}/v1/usage`
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function parseUsageResponse(body: unknown): ProviderBalance {
  const data = record(body)
  if (!data) return { ok: false, errorCode: 'unknown', message: 'Unexpected usage response' }

  const unit = typeof data.unit === 'string' && data.unit ? data.unit : 'USD'
  const todayCost = finiteNumber(record(record(data.usage)?.today)?.actual_cost)
  const extras = todayCost !== undefined ? { todayCost } : {}

  if (data.mode === 'quota_limited') {
    const quota = record(data.quota)
    return {
      ok: true,
      kind: 'quota',
      remaining: finiteNumber(quota?.remaining) ?? finiteNumber(data.remaining) ?? null,
      ...(finiteNumber(quota?.limit) !== undefined && { limit: finiteNumber(quota?.limit) }),
      unit,
      ...extras,
    }
  }

  if (data.subscription !== undefined || (data.balance === undefined && typeof data.planName === 'string')) {
    return {
      ok: true,
      kind: 'subscription',
      remaining: finiteNumber(data.remaining) ?? null,
      unit,
      ...(typeof data.planName === 'string' && { planName: data.planName }),
      ...extras,
    }
  }

  const remaining = finiteNumber(data.balance) ?? finiteNumber(data.remaining)
  if (remaining === undefined) return { ok: false, errorCode: 'unknown', message: 'Usage response has no balance' }
  return { ok: true, kind: 'balance', remaining, unit, ...extras }
}

export async function fetchProviderBalance(provider: SavedProvider): Promise<ProviderBalance> {
  if (!supportsProviderBalance(provider)) {
    return { ok: false, errorCode: 'unsupported', message: 'This provider does not publish a balance' }
  }
  const apiKey = provider.apiKey.trim()
  if (!apiKey) return { ok: false, errorCode: 'auth-failed', message: 'API key is empty' }

  const url = buildUsageUrl(provider.baseUrl)
  const networkSettings = resolveProviderNetworkSettings(await loadNetworkSettings(), provider.proxy)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...getNetworkProxyFetchOptions(networkSettings, url),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, errorCode: 'network', message: message.split(apiKey).join('***') }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, errorCode: 'auth-failed', message: `HTTP ${response.status}` }
  }
  if (!response.ok) return { ok: false, errorCode: 'unknown', message: `HTTP ${response.status}` }

  try {
    return parseUsageResponse(await response.json())
  } catch {
    return { ok: false, errorCode: 'unknown', message: 'Usage response is not JSON' }
  }
}
