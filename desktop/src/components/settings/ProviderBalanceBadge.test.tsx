import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ProviderBalanceBadge, clearProviderBalanceCache } from './ProviderBalanceBadge'
import { providersApi } from '../../api/providers'
import { useSettingsStore } from '../../stores/settingsStore'
import { isLuoyeAiProvider } from '../../lib/luoyeAiSetup'
import type { ProviderBalance } from '../../types/provider'

function mockBalance(...results: ProviderBalance[]) {
  const spy = vi.spyOn(providersApi, 'balance')
  for (const balance of results) spy.mockResolvedValueOnce({ balance })
  return spy
}

describe('ProviderBalanceBadge', () => {
  beforeEach(() => {
    clearProviderBalanceCache()
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the wallet balance with today\'s spend in the tooltip', async () => {
    mockBalance({ ok: true, kind: 'balance', remaining: 12.345, unit: 'USD', todayCost: 0.5 })
    render(<ProviderBalanceBadge providerId="p1" />)
    const button = await screen.findByRole('button', { name: /Balance \$12\.35/ })
    expect(button).toHaveAttribute('title', expect.stringContaining('Spent today $0.50'))
  })

  it('shows a per-key quota against its limit', async () => {
    mockBalance({ ok: true, kind: 'quota', remaining: 3.2, limit: 10, unit: 'USD' })
    render(<ProviderBalanceBadge providerId="p1" />)
    expect(await screen.findByText('Quota $3.20 / $10.00')).toBeInTheDocument()
  })

  it('names a subscription plan that reports no remaining amount', async () => {
    mockBalance({ ok: true, kind: 'subscription', remaining: null, unit: 'USD', planName: 'Pro' })
    render(<ProviderBalanceBadge providerId="p1" />)
    expect(await screen.findByText('Pro')).toBeInTheDocument()
  })

  it('reports a rejected key', async () => {
    mockBalance({ ok: false, errorCode: 'auth-failed', message: 'HTTP 401' })
    render(<ProviderBalanceBadge providerId="p1" />)
    expect(await screen.findByText('Invalid key')).toBeInTheDocument()
  })

  it('renders nothing for a provider without a balance', async () => {
    const spy = mockBalance({ ok: false, errorCode: 'unsupported', message: 'no' })
    const { container } = render(<ProviderBalanceBadge providerId="p1" />)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('reuses a fresh result across mounts and refetches on click', async () => {
    const spy = mockBalance(
      { ok: true, kind: 'balance', remaining: 5, unit: 'USD' },
      { ok: true, kind: 'balance', remaining: 4, unit: 'USD' },
    )
    const first = render(<ProviderBalanceBadge providerId="p1" />)
    await screen.findByText('Balance $5.00')
    first.unmount()

    render(<ProviderBalanceBadge providerId="p1" />)
    expect(screen.getByText('Balance $5.00')).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(await screen.findByText('Balance $4.00')).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('isLuoyeAiProvider', () => {
  it('matches the preset and hand-made providers on either node', () => {
    expect(isLuoyeAiProvider({ presetId: 'luoyeai', baseUrl: '' })).toBe(true)
    expect(isLuoyeAiProvider({ presetId: 'custom', baseUrl: 'https://cn-api.3zapi.com/v1' })).toBe(true)
    expect(isLuoyeAiProvider({ presetId: 'custom', baseUrl: 'https://ai.3zapi.com' })).toBe(true)
    expect(isLuoyeAiProvider({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com' })).toBe(false)
    expect(isLuoyeAiProvider({ presetId: 'custom', baseUrl: '' })).toBe(false)
  })
})
