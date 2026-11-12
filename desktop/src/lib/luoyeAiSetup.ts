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
 * at a model the key cannot call. An empty catalog (a gateway that hides
 * /models) falls back to the preset's defaults.
 */
export function selectLuoyeAiModels(modelIds: readonly string[]): LuoyeAiModelSelection {
  const ids = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
  const imageModel = pick(ids, IMAGE_PREFERENCES, (id) => /gpt-image/i.test(id))
    ?? (ids.length === 0 ? LUOYEAI_PRESET.defaultImageGeneration?.model ?? null : null)

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

  if (!claude && !gpt) {
    return { claude: { ...LUOYEAI_PRESET.defaultModels }, gpt: null, imageModel }
  }
  return { claude, gpt, imageModel }
}

export type LuoyeAiProbe = {
  region: LuoyeAiRegion
  baseUrl: string
  modelIds: string[]
}

export type LuoyeAiSetupErrorCode = 'invalid-key' | 'unreachable'

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
      result.errorCode === 'auth-failed' ? 'invalid-key' : 'unreachable',
      result.message,
    )
  }
  return { region, baseUrl, modelIds: result.models.map((model) => model.id) }
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
    const invalidKey = failures.some((failure) => failure instanceof LuoyeAiSetupError && failure.code === 'invalid-key')
    const first = failures[0]
    throw new LuoyeAiSetupError(
      invalidKey ? 'invalid-key' : 'unreachable',
      first instanceof Error ? first.message : String(first),
    )
  }
}

export function buildLuoyeAiProviderInputs(
  apiKey: string,
  probe: LuoyeAiProbe,
  names: { claude: string; gpt: string },
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
  if (selection.claude) inputs.push({ ...base, name: names.claude, models: selection.claude })
  if (selection.gpt) inputs.push({ ...base, name: names.gpt, models: selection.gpt })
  return inputs
}

/** The first-run prompt is for a fresh install: any saved provider means setup already happened. */
export function needsLuoyeAiSetup(providers: readonly SavedProvider[]): boolean {
  return providers.length === 0
}
