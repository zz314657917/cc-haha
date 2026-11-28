import { useId, useRef, useState } from 'react'
import { providersApi, type NodeHealthResult } from '@/api/providers'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useTranslation } from '@/i18n'

const regions = ['hk', 'us'] as const
type Row = NodeHealthResult | { status: 'unavailable' }

export function LuoyeNodeHealth() {
  const t = useTranslation()
  const keyId = useId()
  const busy = useRef(false)
  const [key, setKey] = useState('')
  const [running, setRunning] = useState(false)
  const [rows, setRows] = useState<Partial<Record<NodeHealthResult['region'], Row>>>({})
  async function check() {
    if (busy.current) return
    busy.current = true
    setRunning(true)
    setRows({})
    const credential = key.trim() || undefined
    setKey('')
    try {
      await Promise.all(regions.map(async region => {
        let row: Row
        try { row = await providersApi.checkLuoyeNode(region, credential) }
        catch { row = { status: 'unavailable' } }
        setRows(prev => ({ ...prev, [region]: row }))
      }))
    } finally {
      busy.current = false
      setRunning(false)
    }
  }
  return (
    <details className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-[13px]">
      <summary className="cursor-pointer font-medium focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">{t('nodeHealth.title')}</summary>
      <p id={`${keyId}-hint`} className="my-2 text-[var(--color-text-secondary)]">{t('nodeHealth.hint')}</p>
      <label htmlFor={keyId}>{t('luoyeAi.apiKeyLabel')}</label>
      <div className="my-2 flex flex-wrap items-center gap-2">
        <Input id={keyId} type="password" autoComplete="off" aria-describedby={`${keyId}-hint`} value={key} onChange={e => setKey(e.target.value)} disabled={running} />
        <Button size="sm" onClick={() => void check()} disabled={running}>{t('nodeHealth.title')}</Button>
      </div>
      <ul aria-live="polite">
        {regions.map(region => {
          const row = rows[region]
          if (!row && !running) return null
          return <li key={region}>{t(region === 'hk' ? 'luoyeAi.regionHk' : 'luoyeAi.regionUs')} · {row ? t(`nodeHealth.${row.status}`) : t('common.loading')}{row && 'latencyMs' in row && <> · {t('nodeHealth.latency', { ms: row.latencyMs })}{row.httpStatus && <> · {row.httpStatus}</>}</>}</li>
        })}
      </ul>
    </details>
  )
}
