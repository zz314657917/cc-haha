import { describe, expect, it, vi } from 'vitest'
import {
  LUOYEAI_ENDPOINTS,
  LUOYEAI_PRESET,
  LuoyeAiSetupError,
  buildLuoyeAiProviderInputs,
  needsLuoyeAiSetup,
  probeLuoyeAi,
  selectLuoyeAiModels,
} from './luoyeAiSetup'
import type { ProviderModelsInput, ProviderModelsResult, SavedProvider } from '../types/provider'

const ok = (ids: string[]): ProviderModelsResult => ({
  ok: true,
  models: ids.map((id) => ({ id })),
  endpoint: 'fixture',
})

describe('luoyeAi preset', () => {
  it('ships both regional endpoints and routes Claude models to the Messages API', () => {
    expect(LUOYEAI_ENDPOINTS).toEqual({ hk: 'https://cn-api.3zapi.com/v1', us: 'https://ai.3zapi.com/v1' })
    expect(LUOYEAI_PRESET.apiFormat).toBe('openai_responses')
    expect(LUOYEAI_PRESET.modelApiFormats).toEqual([{ prefixes: ['claude-'], apiFormat: 'anthropic' }])
  })
})

describe('selectLuoyeAiModels', () => {
  it('maps a mixed catalog onto Claude and GPT providers with the preferred image model', () => {
    const selection = selectLuoyeAiModels([
      'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5',
      'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna',
      'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare',
    ])
    expect(selection.claude).toEqual({
      main: 'claude-opus-5-5', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5',
    })
    expect(selection.gpt).toEqual({
      main: 'gpt-6.1-sol', opus: 'gpt-6-astra', sonnet: 'gpt-6.1-sol', haiku: 'gpt-6-luna',
    })
    expect(selection.imageModel).toBe('gpt-image-2.6-sunburst')
  })

  it('leaves out a family the key cannot call instead of guessing a model', () => {
    const selection = selectLuoyeAiModels(['gpt-6-sol', 'gpt-image-2.6-flare'])
    expect(selection.claude).toBeNull()
    expect(selection.gpt?.main).toBe('gpt-6-sol')
    expect(selection.imageModel).toBe('gpt-image-2.6-flare')
  })

  it('does not treat image or audio models as chat models', () => {
    const selection = selectLuoyeAiModels(['claude-sonnet-5-5', 'gpt-image-2.6-flare', 'gpt-realtime'])
    expect(selection.gpt).toBeNull()
    expect(selection.claude?.haiku).toBe('claude-sonnet-5-5')
  })

  it('keeps image generation off when the catalog lists no image model', () => {
    expect(selectLuoyeAiModels(['claude-opus-5-5']).imageModel).toBeNull()
  })

  it('falls back to the preset defaults when the gateway hides its catalog', () => {
    const selection = selectLuoyeAiModels([])
    expect(selection.claude).toEqual(LUOYEAI_PRESET.defaultModels)
    expect(selection.imageModel).toBe('gpt-image-2.6-sunburst')
  })
})

describe('probeLuoyeAi', () => {
  it('auto mode keeps whichever node answers first', async () => {
    const fetchModels = vi.fn(async (input: ProviderModelsInput) => {
      if (input.baseUrl === LUOYEAI_ENDPOINTS.hk) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return ok(['claude-opus-5-5'])
      }
      return ok(['gpt-6-sol'])
    })
    const probe = await probeLuoyeAi('fake-key', 'auto', fetchModels)
    expect(probe).toEqual({ region: 'us', baseUrl: LUOYEAI_ENDPOINTS.us, modelIds: ['gpt-6-sol'] })
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  it('auto mode still succeeds when one node is down', async () => {
    const fetchModels = vi.fn(async (input: ProviderModelsInput): Promise<ProviderModelsResult> =>
      input.baseUrl === LUOYEAI_ENDPOINTS.us
        ? { ok: false, errorCode: 'network', message: 'down', endpointsTried: [] }
        : ok(['claude-opus-5-5']))
    await expect(probeLuoyeAi('fake-key', 'auto', fetchModels)).resolves.toMatchObject({ region: 'hk' })
  })

  it('reports a rejected key as invalid-key', async () => {
    const fetchModels = vi.fn(async (): Promise<ProviderModelsResult> =>
      ({ ok: false, errorCode: 'auth-failed', message: '401', httpStatus: 401, endpointsTried: [] }))
    const error = await probeLuoyeAi('bad-key', 'auto', fetchModels).catch((err) => err)
    expect(error).toBeInstanceOf(LuoyeAiSetupError)
    expect(error.code).toBe('invalid-key')
  })

  it('only asks the chosen node when one is picked', async () => {
    const fetchModels = vi.fn(async () => ok(['claude-opus-5-5']))
    await probeLuoyeAi('fake-key', 'hk', fetchModels)
    expect(fetchModels).toHaveBeenCalledExactlyOnceWith({ baseUrl: LUOYEAI_ENDPOINTS.hk, apiKey: 'fake-key' })
  })
})

describe('buildLuoyeAiProviderInputs', () => {
  it('creates one Claude and one GPT provider sharing the key, node and image model', () => {
    const inputs = buildLuoyeAiProviderInputs('fake-key', {
      region: 'us',
      baseUrl: LUOYEAI_ENDPOINTS.us,
      modelIds: ['claude-opus-5-5', 'gpt-6-sol', 'gpt-image-2.6-sunburst'],
    }, { claude: 'C', gpt: 'G' })
    expect(inputs).toHaveLength(2)
    for (const input of inputs) {
      expect(input).toMatchObject({
        presetId: 'luoyeai',
        apiKey: 'fake-key',
        baseUrl: LUOYEAI_ENDPOINTS.us,
        apiFormat: 'openai_responses',
        authStrategy: 'auth_token',
        imageGeneration: { model: 'gpt-image-2.6-sunburst', protocol: 'openai_images' },
      })
    }
    expect(inputs.map((input) => [input.name, input.models.main])).toEqual([['C', 'claude-opus-5-5'], ['G', 'gpt-6-sol']])
  })

  it('omits image generation when the key has no image model', () => {
    const [input] = buildLuoyeAiProviderInputs('fake-key', {
      region: 'hk', baseUrl: LUOYEAI_ENDPOINTS.hk, modelIds: ['claude-opus-5-5'],
    }, { claude: 'C', gpt: 'G' })
    expect(input).not.toHaveProperty('imageGeneration')
  })
})

describe('needsLuoyeAiSetup', () => {
  it('prompts only a fresh install', () => {
    expect(needsLuoyeAiSetup([])).toBe(true)
    expect(needsLuoyeAiSetup([{ id: 'x' } as SavedProvider])).toBe(false)
  })
})
