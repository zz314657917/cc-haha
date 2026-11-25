import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Eye, EyeOff, KeyRound } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTranslation, type TranslationKey } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import {
  LUOYEAI_ENDPOINTS, LUOYEAI_PRESET, LuoyeAiSetupError, buildLuoyeAiProviderInputs,
  luoyeAiFamily, needsLuoyeAiSetup, probeLuoyeAi, recoverLuoyeAiCreate, type LuoyeAiCreateAttempt,
  type LuoyeAiProbe, type LuoyeAiRegionChoice, type LuoyeAiScope, type LuoyeAiSetupErrorCode,
} from '@/lib/luoyeAiSetup'
import { useProviderStore } from '@/stores/providerStore'
import { useUIStore } from '@/stores/uiStore'
import type { SavedProvider } from '@/types/provider'

const errorKeys: Record<LuoyeAiSetupErrorCode, TranslationKey> = {
  'invalid-key': 'luoyeAi.errorInvalidKey', unreachable: 'luoyeAi.errorUnreachable',
  unsupported: 'luoyeAi.unsupported', 'catalog-unavailable': 'luoyeAi.noCatalog', 'uncertain-save': 'luoyeAi.uncertainSave',
}

/** The store refreshes after each save. Keep the in-flight first-run form mounted until dismissed. */
export function LuoyeAiSetupDialog() {
  const hasLoaded = useProviderStore(s => s.hasLoadedProviders)
  const providers = useProviderStore(s => s.providers)
  const activeId = useProviderStore(s => s.activeId)
  const [started, setStarted] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const requestedLoad = useRef(false)
  useEffect(() => {
    if (requestedLoad.current) return
    requestedLoad.current = true
    const store = useProviderStore.getState()
    if (!store.hasLoadedProviders) void store.fetchProviders()
  }, [])
  if (dismissed || !hasLoaded || (!started && (activeId !== null || !needsLuoyeAiSetup(providers)))) return null
  return <LuoyeAiKeyDialog initialScope="shared" firstRun onStart={() => setStarted(true)} onClose={() => setDismissed(true)} />
}

export function LuoyeAiKeyDialog({ initialScope, target, firstRun = false, onStart, onClose }: {
  initialScope: LuoyeAiScope
  /** Only this specific saved record may be replaced, by explicitly entering a key. */
  target?: SavedProvider
  firstRun?: boolean
  onStart?: () => void
  onClose: () => void
}) {
  const t = useTranslation()
  const [scope, setScope] = useState(initialScope)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [region, setRegion] = useState<LuoyeAiRegionChoice>(target?.baseUrl === LUOYEAI_ENDPOINTS.us ? 'us' : target?.baseUrl === LUOYEAI_ENDPOINTS.hk ? 'hk' : 'auto')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedProvider[]>([])
  const [retry, setRetry] = useState(false)
  const verified = useRef<LuoyeAiProbe | null>(null)
  const pendingCreate = useRef<LuoyeAiCreateAttempt | null>(null)
  const busy = useRef(false)
  const targetFamily = target && luoyeAiFamily(target)
  const trimmedKey = apiKey.trim()
  const locked = submitting || saved.length > 0 || pendingCreate.current !== null
  const handleSubmit = async () => {
    if (!trimmedKey || busy.current) return
    busy.current = true
    setSubmitting(true)
    setError(null)
    onStart?.()
    const completed = [...saved]
    try {
      const store = useProviderStore.getState()
      // A failed response may have arrived after the server committed a create.
      const attempt = pendingCreate.current
      if (retry) {
        await store.fetchProviders()
        const current = useProviderStore.getState()
        if (current.error) throw new Error('Provider list unavailable')
        if (attempt) {
          const recovered = recoverLuoyeAiCreate(attempt, current.providers)
          if (recovered) completed.push(recovered)
          pendingCreate.current = null
        }
      }
      const probe = (attempt || saved.length > 0 ? verified.current : null) ?? await probeLuoyeAi(trimmedKey, region,
        input => store.fetchModels(target?.proxy ? { ...input, proxy: target.proxy } : input))
      verified.current = probe
      const inputs = buildLuoyeAiProviderInputs(trimmedKey, probe, {
        claude: t('luoyeAi.providerNameClaude'), gpt: t('luoyeAi.providerNameGpt'),
      }, scope)
      // Replacing only the key must leave the card's actual model slots usable, not just some
      // other model from the same family. Validate before making any changes to either family.
      if (target && (!inputs.some(input => luoyeAiFamily(input) === targetFamily) ||
        Object.values(target.models).some(id => id && !probe.modelIds.includes(id.trim().replace(/\[1m\]$/i, ''))))) {
        throw new LuoyeAiSetupError('unsupported', 'Key does not support the saved model mapping')
      }
      for (const input of inputs) {
        const family = luoyeAiFamily(input)
        if (completed.some(provider => luoyeAiFamily(provider) === family)) continue
        const { providers } = useProviderStore.getState()
        if (target && family === targetFamily) {
          const current = providers.find(p => p.id === target.id)
          if (!current || luoyeAiFamily(current) !== family) throw new Error('Selected provider changed')
          // Keep custom model slots, protocol, image settings and regional routing. Only replace the key.
          if (current.apiKey !== trimmedKey) await store.updateProvider(current.id, { apiKey: trimmedKey })
          completed.push(current)
        } else if (!providers.some(provider => luoyeAiFamily(provider) === family)) {
          pendingCreate.current = { input, previousIds: new Set(providers.map(p => p.id)) }
          completed.push(await store.createProvider(input))
          pendingCreate.current = null
        }
      }
      if (!completed.length) throw new LuoyeAiSetupError('unsupported', 'No unconfigured family supported by this key')
      if (firstRun && useProviderStore.getState().activeId === null) await store.activateProvider(completed[0]!.id)
      useUIStore.getState().addToast({ type: 'success', message: t('luoyeAi.success', { region: t(probe.region === 'hk' ? 'luoyeAi.regionHk' : 'luoyeAi.regionUs') }) })
      onClose()
    } catch (err) {
      setSaved(completed)
      setRetry(true)
      setError(err instanceof LuoyeAiSetupError && err.code === 'uncertain-save' ? t('luoyeAi.uncertainSave')
        : completed.length ? t('luoyeAi.partial', { names: completed.map(provider => provider.name).join(', ') })
        : err instanceof LuoyeAiSetupError ? t(errorKeys[err.code]) : t('settings.providers.requestFailed'))
    } finally {
      busy.current = false
      setSubmitting(false)
    }
  }
  return (
    <Modal open onClose={() => { if (!busy.current) onClose() }} title={target ? target.name : t('luoyeAi.title')} width={480} typography="interface" footer={(
      <>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>{t(firstRun ? 'luoyeAi.later' : 'common.cancel')}</Button>
        <Button variant="primary" onClick={() => void handleSubmit()} loading={submitting} disabled={!trimmedKey}>{t(firstRun ? 'luoyeAi.start' : 'common.save')}</Button>
      </>
    )}>
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void handleSubmit() }}>
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">{t(target ? 'luoyeAi.replaceHint' : 'luoyeAi.keyHint')}</p>
        <SegmentedControl<LuoyeAiScope> label={t('luoyeAi.scope')} layout="fill" value={scope} onChange={setScope} items={[
          { value: 'shared', label: t('luoyeAi.shared'), disabled: locked },
          { value: 'gpt', label: 'GPT', disabled: locked || targetFamily === 'claude' },
          { value: 'claude', label: 'Claude', disabled: locked || targetFamily === 'gpt' },
        ]} />
        <div className="flex items-end gap-2">
          <Input label={t('luoyeAi.apiKeyLabel')} type={showKey ? 'text' : 'password'} value={apiKey}
            onChange={event => setApiKey(event.target.value)} placeholder={t('luoyeAi.apiKeyPlaceholder')}
            autoComplete="off" spellCheck={false} error={error ?? undefined} containerClassName="flex-1" disabled={locked} />
          <IconButton size="xl" bordered label={t(showKey ? 'luoyeAi.hideKey' : 'luoyeAi.showKey')}
            icon={showKey ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
            onClick={() => setShowKey(value => !value)} className={error ? 'mb-5' : undefined} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">{t('luoyeAi.regionLabel')}</span>
          <SegmentedControl<LuoyeAiRegionChoice> label={t('luoyeAi.regionLabel')} layout="fill" value={region} onChange={setRegion} items={[
            { value: 'auto', label: t('luoyeAi.regionAuto'), disabled: locked || !!target },
            { value: 'hk', label: t('luoyeAi.regionHk'), disabled: locked || !!target },
            { value: 'us', label: t('luoyeAi.regionUs'), disabled: locked || !!target },
          ]} />
        </div>
        {LUOYEAI_PRESET.apiKeyUrl && <Button variant="link" size="sm" className="self-start" icon={<KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => { const url = LUOYEAI_PRESET.apiKeyUrl!; void getDesktopHost().shell.open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer')) }}>
          {t('luoyeAi.getKey')}<ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
        </Button>}
      </form>
    </Modal>
  )
}
