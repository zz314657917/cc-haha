import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { LuoyeAiKeyDialog, LuoyeAiSetupDialog } from './LuoyeAiSetupDialog'
import { providersApi } from '@/api/providers'
import { LUOYEAI_ENDPOINTS } from '@/lib/luoyeAiSetup'
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
    vi.restoreAllMocks()
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

  it('survives the real store list refresh after a partial save and retries only GPT', async () => {
    const records: SavedProvider[] = []
    const list = vi.spyOn(providersApi, 'list').mockImplementation(async () => ({ providers: [...records], activeId: null }))
    let failGpt = true
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async input => {
      if (input.models.main.startsWith('gpt-') && failGpt) { failGpt = false; throw new Error('fixture write failure') }
      const provider = { ...input, apiKey: 'masked', id: `created-${records.length}`, apiFormat: input.apiFormat! }
      records.push(provider)
      return { provider }
    })
    const { activateProvider, fetchModels } = seedStore({ createProvider: initialProviderState.createProvider, fetchProviders: initialProviderState.fetchProviders })
    render(<LuoyeAiSetupDialog />)
    fireEvent.click(screen.getByRole('radio', { name: 'Hong Kong' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fake-shared-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved: 落叶AI · Claude')
    expect(list).toHaveBeenCalled()
    expect(useProviderStore.getState().providers).toHaveLength(1)
    expect(activateProvider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(create.mock.calls.map(([p]) => p.name)).toEqual(['落叶AI · Claude', '落叶AI · GPT', '落叶AI · GPT'])
    expect(records).toHaveLength(2)
    expect(activateProvider).toHaveBeenCalledExactlyOnceWith('created-0')
  })

  it.each(['full', 'masked', 'ambiguous', 'preexisting', 'wrong-node', 'wrong-key'] as const)(
    'reconciles a lost create response without adopting unrelated records (%s)', async scenario => {
      const records: SavedProvider[] = []
      vi.spyOn(providersApi, 'list').mockImplementation(async () => ({ providers: [...records], activeId: null }))
      const create = vi.spyOn(providersApi, 'create').mockImplementation(async input => {
        const committed: SavedProvider = { ...input, id: 'committed', apiFormat: input.apiFormat! }
        records.push(scenario === 'wrong-node' ? { ...committed, baseUrl: LUOYEAI_ENDPOINTS.us }
          : scenario === 'masked' ? { ...committed, apiKey: '***' }
          : scenario === 'wrong-key' ? { ...committed, apiKey: 'different-fixture-key' } : committed)
        if (scenario === 'ambiguous') records.push({ ...committed, id: 'duplicate' })
        throw new Error('fixture reply lost')
      })
      const update = vi.spyOn(providersApi, 'update')
      const { activateProvider, fetchModels } = seedStore({ createProvider: initialProviderState.createProvider, fetchProviders: initialProviderState.fetchProviders })
      fetchModels.mockResolvedValue({ ok: true, endpoint: 'fixture', models: [{ id: 'gpt-5' }] })
      const close = vi.fn()
      if (scenario === 'preexisting') {
        useProviderStore.setState({ providers: [{ id: 'committed', presetId: 'custom', baseUrl: 'https://fixture.invalid' } as SavedProvider] })
        render(<LuoyeAiKeyDialog firstRun initialScope="shared" onClose={close} />)
      } else render(<LuoyeAiSetupDialog />)
      fireEvent.click(screen.getByRole('radio', { name: 'Hong Kong' }))
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fake-recovery-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Start' }))
      expect(await screen.findByRole('alert')).toBeVisible()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })) })
      if (scenario === 'full' || scenario === 'masked') {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(activateProvider).toHaveBeenCalledExactlyOnceWith('committed')
      } else {
        expect(screen.getByRole('alert')).toHaveTextContent('Review the saved configurations')
        expect(close).not.toHaveBeenCalled()
        expect(activateProvider).not.toHaveBeenCalled()
      }
      expect(create).toHaveBeenCalledTimes(1)
      expect(update).not.toHaveBeenCalled()
    },
  )

  it.each([
    { ids: ['gpt-image-2.6-flare', 'unknown'], text: 'does not list the chat models' },
    { ids: [], text: 'Cannot verify the model list' },
  ])('distinguishes unsupported and hidden catalogs without saving ($text)', async ({ ids, text }) => {
    const { createProvider, activateProvider } = seedStore({ fetchModels: vi.fn(async () => ({ ok: true as const, models: ids.map(id => ({ id })), endpoint: 'fixture' })) })
    render(<LuoyeAiSetupDialog />)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fixture' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(createProvider).not.toHaveBeenCalled()
    expect(activateProvider).not.toHaveBeenCalled()
  })

  it('updates only the explicitly selected record, never an independent or duplicate key', async () => {
    const record = (id: string, main: string): SavedProvider => ({ id, name: id, presetId: 'luoyeai', baseUrl: LUOYEAI_ENDPOINTS.hk,
      apiKey: 'masked', apiFormat: 'openai_responses', models: { main, sonnet: main, haiku: main, opus: main } })
    const target = record('my-gpt', 'gpt-6-sol')
    const updateProvider = vi.fn(async () => target)
    const { createProvider, activateProvider, fetchModels } = seedStore({ providers: [target, record('other-gpt', 'gpt-5'), record('independent-claude', 'claude-opus-5')], activeId: 'independent-claude', updateProvider })
    fetchModels.mockResolvedValueOnce({ ok: true, models: [{ id: 'gpt-5' }], endpoint: 'fixture' })
    const close = vi.fn()
    render(<LuoyeAiKeyDialog initialScope="gpt" target={target} onClose={close} />)
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    fireEvent.click(screen.getByRole('radio', { name: 'All available families' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fake-incompatible-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('does not list the chat models')
    expect(createProvider).not.toHaveBeenCalled()
    expect(updateProvider).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fake-new-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(updateProvider).toHaveBeenCalledExactlyOnceWith(target.id, { apiKey: 'fake-new-key' })
    expect(createProvider).not.toHaveBeenCalled()
    expect(activateProvider).not.toHaveBeenCalled()
  })

  it('can be dismissed for this launch', () => {
    seedStore()
    render(<LuoyeAiSetupDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
