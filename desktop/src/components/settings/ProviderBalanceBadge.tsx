import { useCallback, useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useTranslation } from '../../i18n'
import { providersApi } from '../../api/providers'
import type { ProviderBalance } from '../../types/provider'

/** Below this the badge turns to a warning so the user tops up before a turn fails mid-task. */
export const LOW_BALANCE_THRESHOLD = 1
const CACHE_TTL_MS = 60_000

const cache = new Map<string, { at: number; balance: ProviderBalance }>()

/** Test hook: the cache outlives a single render tree on purpose. */
export function clearProviderBalanceCache() {
  cache.clear()
}

function formatAmount(value: number, unit: string): string {
  const amount = value.toFixed(2)
  return unit === 'USD' ? `$${amount}` : `${amount} ${unit}`
}

type Props = {
  providerId: string
}

/**
 * Remaining credit for a 落叶AI (sub2api) provider, fetched through the local
 * server so the key never reaches the renderer. Click to refresh.
 */
export function ProviderBalanceBadge({ providerId }: Props) {
  const t = useTranslation()
  const [balance, setBalance] = useState<ProviderBalance | null>(() => cache.get(providerId)?.balance ?? null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (force: boolean) => {
    const cached = cache.get(providerId)
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setBalance(cached.balance)
      return
    }
    setLoading(true)
    try {
      const { balance: next } = await providersApi.balance(providerId)
      cache.set(providerId, { at: Date.now(), balance: next })
      setBalance(next)
    } catch (err) {
      setBalance({ ok: false, errorCode: 'network', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }, [providerId])

  useEffect(() => {
    void load(false)
  }, [load])

  if (balance && !balance.ok && balance.errorCode === 'unsupported') return null

  let label: string
  let tone: 'neutral' | 'warning' | 'danger' = 'neutral'
  let detail: string | undefined
  if (!balance) {
    label = t('providerBalance.loading')
  } else if (!balance.ok) {
    label = t(balance.errorCode === 'auth-failed' ? 'providerBalance.invalidKey' : 'providerBalance.failed')
    tone = 'danger'
    detail = balance.message
  } else if (balance.remaining === null) {
    label = balance.planName ?? t('providerBalance.unlimited')
  } else {
    const remaining = formatAmount(balance.remaining, balance.unit)
    label = balance.limit !== undefined
      ? t('providerBalance.quota', { remaining, limit: formatAmount(balance.limit, balance.unit) })
      : t('providerBalance.balance', { amount: remaining })
    if (balance.remaining < LOW_BALANCE_THRESHOLD) tone = 'warning'
    if (balance.todayCost !== undefined) {
      detail = t('providerBalance.todayCost', { amount: formatAmount(balance.todayCost, balance.unit) })
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        if (!loading) void load(true)
      }}
      aria-busy={loading || undefined}
      aria-label={t('providerBalance.refresh', { label })}
      title={[detail, t('providerBalance.clickToRefresh')].filter(Boolean).join(' · ')}
      className="rounded-full focus-visible:shadow-[var(--shadow-focus-ring)] outline-none"
    >
      <Badge tone={tone} icon={<Wallet size={11} strokeWidth={1.75} aria-hidden="true" />} className={loading ? 'opacity-60' : undefined}>
        {label}
      </Badge>
    </button>
  )
}
