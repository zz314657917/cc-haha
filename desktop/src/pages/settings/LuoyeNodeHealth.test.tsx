import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { providersApi } from '@/api/providers'
import { useSettingsStore } from '@/stores/settingsStore'
import { LuoyeNodeHealth } from './LuoyeNodeHealth'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('only checks on click and independently reports anonymous 401 and the other node’s latency', async () => {
  useSettingsStore.setState({ locale: 'en' })
  const probe = vi.spyOn(providersApi, 'checkLuoyeNode').mockImplementation(async region => ({ region, status: region === 'hk' ? 'authRequired' : 'responded', latencyMs: 21, httpStatus: region === 'hk' ? 401 : 200 }))
  render(<LuoyeNodeHealth />)
  fireEvent.click(screen.getByText('Check Hong Kong and US nodes', { selector: 'summary' }))
  expect(probe).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Check Hong Kong and US nodes' }))
  expect(await screen.findByText(/Hong Kong · Reachable; authentication required · 21 ms · 401/)).toBeTruthy()
  expect(await screen.findByText(/United States · Endpoint responded · 21 ms · 200/)).toBeTruthy()
  expect(probe.mock.calls).toEqual([['hk', undefined], ['us', undefined]])
})

it('clears the transient key and does not render transport error text', async () => {
  useSettingsStore.setState({ locale: 'en' })
  const probe = vi.spyOn(providersApi, 'checkLuoyeNode').mockRejectedValue(new Error('fixture-secret'))
  render(<LuoyeNodeHealth />)
  fireEvent.click(screen.getByText('Check Hong Kong and US nodes', { selector: 'summary' }))
  const field = screen.getByLabelText('API Key') as HTMLInputElement
  fireEvent.change(field, { target: { value: 'fixture-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Check Hong Kong and US nodes' }))
  expect(await screen.findByText(/Hong Kong · Local check unavailable/)).toBeTruthy()
  expect(probe.mock.calls).toEqual([['hk', 'fixture-secret'], ['us', 'fixture-secret']])
  expect(field.value).toBe('')
  expect(document.body.textContent).not.toContain('fixture-secret')
})
