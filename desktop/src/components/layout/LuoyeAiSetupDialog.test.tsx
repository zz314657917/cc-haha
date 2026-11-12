import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { LuoyeAiSetupDialog } from './LuoyeAiSetupDialog'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import type { SavedProvider } from '../../types/provider'

const initialProviderState = useProviderStore.getState()

function seedStore(overrides: Partial<ReturnType<typeof useProviderStore.getState>> = {}) {
  const createProvider = vi.fn(async (input) => ({ ...input, id: `id-${input.name}` }) as SavedProvider)
  const activateProvider = vi.fn(async () => {})
  const fetchModels = vi.fn(async () => ({
    ok: true as const,
    models: ['claude-opus-5-5', 'gpt-6-sol', 'gpt-image-2.6-sunburst'].map((id) => ({ id })),
    endpoint: 'fixture',
  }))
  useProviderStore.setState({
    providers: [],
    hasLoadedProviders: true,
    createProvider,
    activateProvider,
    fetchModels,
    fetchProviders: vi.fn(async () => {}),
    ...overrides,
  })
  return { createProvider, activateProvider, fetchModels }
}

describe('LuoyeAiSetupDialog', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ toasts: [] })
  })

  afterEach(() => {
    cleanup()
    useProviderStore.setState(initialProviderState)
  })

  it('stays hidden once any provider is saved', () => {
    seedStore({ providers: [{ id: 'existing' } as SavedProvider] })
    render(<LuoyeAiSetupDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays hidden until the provider list has loaded', () => {
    seedStore({ hasLoadedProviders: false })
    render(<LuoyeAiSetupDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('creates Claude and GPT providers from one key and activates Claude', async () => {
    const { createProvider, activateProvider, fetchModels } = seedStore()
    render(<LuoyeAiSetupDialog />)

    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toBeDisabled()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '  fake-key  ' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Hong Kong' }))
    await act(async () => { fireEvent.click(start) })

    await waitFor(() => expect(activateProvider).toHaveBeenCalledWith('id-落叶AI · Claude'))
    expect(fetchModels).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'https://cn-api.3zapi.com/v1', apiKey: 'fake-key' })
    expect(createProvider).toHaveBeenCalledTimes(2)
    expect(createProvider.mock.calls.map(([input]) => input.models.main)).toEqual(['claude-opus-5-5', 'gpt-6-sol'])
    expect(createProvider.mock.calls[0]![0]).toMatchObject({
      apiKey: 'fake-key',
      imageGeneration: { model: 'gpt-image-2.6-sunburst' },
    })
    expect(useUIStore.getState().toasts.at(-1)?.message).toContain('Hong Kong')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a rejected key inline and saves nothing', async () => {
    const { createProvider } = seedStore({
      fetchModels: vi.fn(async () => ({
        ok: false as const, errorCode: 'auth-failed' as const, message: '401', endpointsTried: [],
      })),
    })
    render(<LuoyeAiSetupDialog />)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'bad-key' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })) })

    expect(await screen.findByRole('alert')).toHaveTextContent('This API key was rejected')
    expect(createProvider).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('can be dismissed for this launch', () => {
    seedStore()
    render(<LuoyeAiSetupDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
