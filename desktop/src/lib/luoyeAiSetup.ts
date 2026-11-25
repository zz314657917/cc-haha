import { BUNDLED_PROVIDER_PRESETS } from '../config/providerPresets'
import type {
  CreateProviderInput,
  ModelMapping,
  ProviderModelsInput,
  ProviderModelsResult,
  SavedProvider,
} from '../types/provider'

export const LUOYEAI_PRESET_ID = 'luoyeai'

export type LuoyeAiRegion = 'hk' | 'us'
export type LuoyeAiRegionChoice = LuoyeAiRegion | 'auto'

const preset = BUNDLED_PROVIDER_PRESETS.find((candidate) => candidate.id === LUOYEAI_PRESET_ID)
if (!preset) throw new Error(`Missing bundled provider preset: ${LUOYEAI_PRESET_ID}`)
export const LUOYEAI_PRESET = preset

export const LUOYEAI_ENDPOINTS: Record<LuoyeAiRegion, string> = {
  hk: endpointFor('hk'),
  us: endpointFor('us'),
}

function endpointFor(region: LuoyeAiRegion): string {
  const endpoint = LUOYEAI_PRESET.regionalEndpoints?.find((candidate) => candidate.region === region)
  if (!endpoint) throw new Error(`Missing ${region} endpoint on preset ${LUOYEAI_PRESET_ID}`)
  return endpoint.baseUrl
}

const LUOYEAI_HOSTS = new Set(Object.values(LUOYEAI_ENDPOINTS).map((url) => new URL(url).host.toLowerCase()))

/** Mirrors the server's check, so the balance badge is only rendered where the server will answer. */
export function isLuoyeAiProvider(provider: Pick<SavedProvider, 'presetId' | 'baseUrl'>): boolean {
  if (provider.presetId === LUOYEAI_PRESET_ID) return true
  try {
    return LUOYEAI_HOSTS.has(new URL(provider.baseUrl).host.toLowerCase())
  } catch {
    return false
  }
}

const CLAUDE_PREFERENCES = {
  opus: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  sonnet: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'],
  haiku: ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
}

const GPT_PREFERENCES = {
  main: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5'],
  opus: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol'],
  haiku: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5-mini'],
}

const IMAGE_PREFERENCES = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare']

function pick(ids: readonly string[], preferred: readonly string[], fallback?: (id: string) => boolean): string | undefined {
  const byLower = new Map(ids.map((id) => [id.toLowerCase(), id]))
  for (const candidate of preferred) {
    const match = byLower.get(candidate.toLowerCase())
    if (match) return match
  }
  return fallback ? ids.find(fallback) : undefined
}

const isGptChatModel = (id: string) => /^gpt-/i.test(id) && !/image|audio|realtime|tts|transcribe|embedding/i.test(id)

export type LuoyeAiModelSelection = {
  claude: ModelMapping | null
  gpt: ModelMapping | null
  /** Null when the key's catalog lists no image model, so ImageGen stays off. */
  imageModel: string | null
}

/**
 * Maps the gateway's live catalog onto provider slots. A sub2api key belongs to
 * one group, and a group serves one platform, so a key may carry only Claude or
 * only GPT. A family the catalog does not list is left out rather than pointed
 * at a model the key cannot call. A hidden catalog needs manual setup.
 */
export function selectLuoyeAiModels(modelIds: readonly string[]): LuoyeAiModelSelection {
  const ids = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
  const imageModel = pick(ids, IMAGE_PREFERENCES, (id) => /gpt-image/i.test(id)) ?? null

  const opus = pick(ids, CLAUDE_PREFERENCES.opus, (id) => /^claude-opus/i.test(id))
  const sonnet = pick(ids, CLAUDE_PREFERENCES.sonnet, (id) => /^claude-sonnet/i.test(id))
  const haiku = pick(ids, CLAUDE_PREFERENCES.haiku, (id) => /^claude-haiku/i.test(id))
  const anyClaude = opus ?? sonnet ?? haiku ?? ids.find((id) => /^claude-/i.test(id))
  const claude: ModelMapping | null = anyClaude
    ? {
        main: opus ?? sonnet ?? anyClaude,
        opus: opus ?? sonnet ?? anyClaude,
        sonnet: sonnet ?? opus ?? anyClaude,
        haiku: haiku ?? sonnet ?? opus ?? anyClaude,
      }
    : null

  const gptMain = pick(ids, GPT_PREFERENCES.main, isGptChatModel)
  const gpt: ModelMapping | null = gptMain
    ? {
        main: gptMain,
        opus: pick(ids, GPT_PREFERENCES.opus) ?? gptMain,
        sonnet: gptMain,
        haiku: pick(ids, GPT_PREFERENCES.haiku) ?? gptMain,
      }
    : null

  return { claude, gpt, imageModel }
}

export type LuoyeAiFamily = 'claude' | 'gpt'
export type LuoyeAiScope = 'shared' | LuoyeAiFamily

/** Identity is based on the endpoint/preset and model, not the editable label or masked key. */
export function luoyeAiFamily(provider: Pick<SavedProvider, 'presetId' | 'baseUrl' | 'models'>): LuoyeAiFamily | null {
  if (!isLuoyeAiProvider(provider)) return null
  const main = provider.models.main.trim()
  return /^claude-/i.test(main) ? 'claude' : isGptChatModel(main) ? 'gpt' : null
}

export type LuoyeAiCreateAttempt = { input: CreateProviderInput; previousIds: Set<string> }

/** After a lost create response, use the freshly reloaded list rather than replaying the write.
 * A masked key is not an identity. Match all submitted public settings and require one new ID. */
export function recoverLuoyeAiCreate({ input, previousIds }: LuoyeAiCreateAttempt, providers: readonly SavedProvider[]): SavedProvider | undefined {
  const added = providers.filter(provider => !previousIds.has(provider.id))
  const matches = added.filter(p => p.name === input.name && p.presetId === input.presetId && p.baseUrl === input.baseUrl
    && p.apiFormat === input.apiFormat && p.authStrategy === input.authStrategy
    && (p.apiKey === input.apiKey || !p.apiKey || /^[*•]+$/.test(p.apiKey))
    && (['main', 'fable', 'haiku', 'sonnet', 'opus'] as const).every(slot => p.models[slot] === input.models[slot])
    && p.imageGeneration?.model === input.imageGeneration?.model && p.imageGeneration?.protocol === input.imageGeneration?.protocol
    && !p.imageGeneration?.baseUrl && !p.imageGeneration?.apiKey && !p.notes && !p.proxy)
  if (matches.length === 1) return matches[0]
  if (added.length || providers.some(p => luoyeAiFamily(p) === luoyeAiFamily(input))) {
    throw new LuoyeAiSetupError('uncertain-save', 'Cannot identify the saved configuration')
  }
  return undefined
}

export type LuoyeAiProbe = {
  region: LuoyeAiRegion
  baseUrl: string
  modelIds: string[]
}

export type LuoyeAiSetupErrorCode = 'invalid-key' | 'unreachable' | 'catalog-unavailable' | 'unsupported' | 'uncertain-save'

export class LuoyeAiSetupError extends Error {
  constructor(readonly code: LuoyeAiSetupErrorCode, message: string) {
    super(message)
    this.name = 'LuoyeAiSetupError'
  }
}

type FetchModels = (input: ProviderModelsInput) => Promise<ProviderModelsResult>

async function probeRegion(region: LuoyeAiRegion, apiKey: string, fetchModels: FetchModels): Promise<LuoyeAiProbe> {
  const baseUrl = LUOYEAI_ENDPOINTS[region]
  const result = await fetchModels({ baseUrl, apiKey })
  if (!result.ok) {
    throw new LuoyeAiSetupError(
      result.errorCode === 'auth-failed' ? 'invalid-key'
        : result.errorCode === 'endpoint-not-found' || result.errorCode === 'not-supported' ? 'catalog-unavailable' : 'unreachable',
      result.message,
    )
  }
  const modelIds = result.models.map((model) => model.id.trim()).filter(Boolean)
  if (!modelIds.length) throw new LuoyeAiSetupError('catalog-unavailable', 'Empty model catalog')
  return { region, baseUrl, modelIds }
}

/**
 * Validates the key and picks a node. `auto` asks both nodes at once and keeps
 * whichever answers first, which is the node that is faster from this machine.
 */
export async function probeLuoyeAi(
  apiKey: string,
  choice: LuoyeAiRegionChoice,
  fetchModels: FetchModels,
): Promise<LuoyeAiProbe> {
  if (choice !== 'auto') return probeRegion(choice, apiKey, fetchModels)

  const regions: LuoyeAiRegion[] = ['hk', 'us']
  const attempts = regions.map((region) => probeRegion(region, apiKey, fetchModels))
  try {
    return await Promise.any(attempts)
  } catch (error) {
    const failures = error instanceof AggregateError ? error.errors : [error]
    for (const code of ['invalid-key', 'catalog-unavailable'] as const) {
      const failure = failures.find((item) => item instanceof LuoyeAiSetupError && item.code === code)
      if (failure) throw failure
    }
    throw new LuoyeAiSetupError('unreachable', 'No reachable node')
  }
}

export function buildLuoyeAiProviderInputs(
  apiKey: string,
  probe: LuoyeAiProbe,
  names: { claude: string; gpt: string },
  scope: LuoyeAiScope = 'shared',
): CreateProviderInput[] {
  const selection = selectLuoyeAiModels(probe.modelIds)
  const base = {
    presetId: LUOYEAI_PRESET_ID,
    apiKey,
    baseUrl: probe.baseUrl,
    authStrategy: LUOYEAI_PRESET.authStrategy,
    apiFormat: LUOYEAI_PRESET.apiFormat,
    ...(selection.imageModel && {
      imageGeneration: { model: selection.imageModel, protocol: 'openai_images' as const },
    }),
  }
  const inputs: CreateProviderInput[] = []
  if (selection.claude && scope !== 'gpt') inputs.push({ ...base, name: names.claude, models: selection.claude })
  if (selection.gpt && scope !== 'claude') inputs.push({ ...base, name: names.gpt, models: selection.gpt })
  if (!inputs.length) throw new LuoyeAiSetupError('unsupported', 'No supported chat model for this selection')
  return inputs
}

/** The first-run prompt is for a fresh install: any saved provider means setup already happened. */
export function needsLuoyeAiSetup(providers: readonly SavedProvider[]): boolean {
  return providers.length === 0
}
