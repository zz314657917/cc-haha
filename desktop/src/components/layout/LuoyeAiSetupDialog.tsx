import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Eye, EyeOff, KeyRound } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import {
  LUOYEAI_PRESET,
  LuoyeAiSetupError,
  buildLuoyeAiProviderInputs,
  needsLuoyeAiSetup,
  probeLuoyeAi,
  type LuoyeAiRegionChoice,
} from '../../lib/luoyeAiSetup'
import { useProviderStore } from '../../stores/providerStore'
import { useUIStore } from '../../stores/uiStore'

function openExternalUrl(url: string) {
  void getDesktopHost().shell.open(url)
    .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
}

/**
 * First-run prompt for the bundled 落叶AI gateway: one API key creates and
 * activates ready-to-use Claude and GPT providers, with image generation on.
 * Shown once per launch while no provider is saved; dismissing it leaves the
 * regular provider settings untouched.
 */
export function LuoyeAiSetupDialog() {
  const t = useTranslation()
  const hasLoadedProviders = useProviderStore((s) => s.hasLoadedProviders)
  const providers = useProviderStore((s) => s.providers)
  const [dismissed, setDismissed] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [region, setRegion] = useState<LuoyeAiRegionChoice>('auto')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestedLoad = useRef(false)

  useEffect(() => {
    if (requestedLoad.current) return
    requestedLoad.current = true
    const store = useProviderStore.getState()
    if (!store.hasLoadedProviders) void store.fetchProviders()
  }, [])

  const open = !dismissed && hasLoadedProviders && needsLuoyeAiSetup(providers)
  const trimmedKey = apiKey.trim()

  const handleSubmit = async () => {
    if (!trimmedKey || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const store = useProviderStore.getState()
      const probe = await probeLuoyeAi(trimmedKey, region, store.fetchModels)
      const inputs = buildLuoyeAiProviderInputs(trimmedKey, probe, {
        claude: t('luoyeAi.providerNameClaude'),
        gpt: t('luoyeAi.providerNameGpt'),
      })
      const created = []
      for (const input of inputs) created.push(await store.createProvider(input))
      if (created[0]) await store.activateProvider(created[0].id)
      useUIStore.getState().addToast({
        type: 'success',
        message: t('luoyeAi.success', { region: t(probe.region === 'hk' ? 'luoyeAi.regionHk' : 'luoyeAi.regionUs') }),
      })
      setDismissed(true)
    } catch (err) {
      if (err instanceof LuoyeAiSetupError) {
        setError(t(err.code === 'invalid-key' ? 'luoyeAi.errorInvalidKey' : 'luoyeAi.errorUnreachable'))
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) setDismissed(true) }}
      title={t('luoyeAi.title')}
      width={480}
      typography="interface"
      footer={(
        <>
          <Button variant="ghost" onClick={() => setDismissed(true)} disabled={submitting}>
            {t('luoyeAi.later')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!trimmedKey}
          >
            {t('luoyeAi.start')}
          </Button>
        </>
      )}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
      >
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          {t('luoyeAi.description')}
        </p>
        <div className="flex items-end gap-2">
          <Input
            label={t('luoyeAi.apiKeyLabel')}
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t('luoyeAi.apiKeyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            error={error ?? undefined}
            containerClassName="flex-1"
            disabled={submitting}
          />
          <IconButton
            size="xl"
            bordered
            label={t(showKey ? 'luoyeAi.hideKey' : 'luoyeAi.showKey')}
            icon={showKey
              ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
              : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => setShowKey((value) => !value)}
            className={error ? 'mb-5' : undefined}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">{t('luoyeAi.regionLabel')}</span>
          <SegmentedControl<LuoyeAiRegionChoice>
            label={t('luoyeAi.regionLabel')}
            layout="fill"
            value={region}
            onChange={setRegion}
            items={[
              { value: 'auto', label: t('luoyeAi.regionAuto') },
              { value: 'hk', label: t('luoyeAi.regionHk') },
              { value: 'us', label: t('luoyeAi.regionUs') },
            ]}
          />
        </div>
        {LUOYEAI_PRESET.apiKeyUrl && (
          <Button
            variant="link"
            size="sm"
            className="self-start"
            icon={<KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => openExternalUrl(LUOYEAI_PRESET.apiKeyUrl!)}
          >
            {t('luoyeAi.getKey')}
            <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        )}
      </form>
    </Modal>
  )
}
