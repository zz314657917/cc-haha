import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { accountErrorKey } from '@/hooks/useRailAccount'
import { useTranslation, type TranslationKey } from '@/i18n'
import type { AccountAnnouncement, AccountResult, DesktopHost } from '@/lib/desktopHost'

type Props = {
  api: DesktopHost['account']
  unreadCount?: number
  onExpired: () => void
  onRead: () => void
}

/** Mounted only for a confirmed profile. Changing profile unmounts its entire feed. */
export function RailAnnouncements({ api, unreadCount, onExpired, onRead }: Props) {
  const t = useTranslation()
  const [items, setItems] = useState<AccountAnnouncement[]>([])
  const [cursor, setCursor] = useState<string>()
  const [selected, setSelected] = useState<AccountAnnouncement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<TranslationKey | null>(null)
  const version = useRef(0)
  const failed = useCallback((result: Extract<AccountResult<unknown>, { ok: false }>) => {
    if (result.error.code === 'unauthorized') onExpired()
    else setError(accountErrorKey(result.error.code))
  }, [onExpired])
  const load = useCallback(async (after?: string) => {
    const current = ++version.current
    setLoading(true)
    setError(null)
    try {
      const result = await api.listAnnouncements(after ? { cursor: after } : {})
      if (current !== version.current) return
      if (!result.ok) { failed(result); return }
      setItems((previous) => after ? [...previous, ...result.data.items] : result.data.items)
      setCursor(result.data.nextCursor)
    } catch {
      if (current === version.current) setError('rail.serviceUnavailable')
    } finally {
      if (current === version.current) setLoading(false)
    }
  }, [api, failed])
  useEffect(() => {
    void load()
    return () => { version.current++ }
  }, [load])

  const mark = async (item?: AccountAnnouncement) => {
    if (item) setSelected(item)
    if (item?.readAt) return
    const current = ++version.current
    setLoading(true)
    setError(null)
    try {
      const result = await (item ? api.markAnnouncementRead({ id: item.id }) : api.markAllAnnouncementsRead())
      if (current !== version.current) return
      if (!result.ok) { failed(result); return }
      onRead()
      await load()
    } catch {
      if (current === version.current) setError('rail.serviceUnavailable')
    } finally {
      if (current === version.current) setLoading(false)
    }
  }
  return <div className="space-y-3">
    {error && <p role="alert" className="text-[13px] text-[var(--color-error)]">{t(error)}</p>}
    {selected ? <article className="space-y-2">
      <Button size="sm" variant="secondary" onClick={() => setSelected(null)}>{t('rail.back')}</Button>
      <h3 className="break-words text-[15px] font-semibold">{selected.title}</h3>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-5">{selected.body ?? selected.summary}</p>
    </article> : <>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" disabled={loading || !(unreadCount || items.some((item) => !item.readAt))} onClick={() => void mark()}>{t('rail.markAllRead')}</Button>
        <IconButton icon={<RefreshCw />} label={t('rail.refresh')} disabled={loading} onClick={() => void load()} />
      </div>
      {loading && <p role="status">{t('common.loading')}</p>}
      {!loading && !error && items.length === 0 && <EmptyState size="sm" variant="plain" description={t('rail.noAnnouncements')} />}
      <ul className="divide-y divide-[var(--color-border)]">
        {items.map((item) => <li key={item.id}>
          <button type="button" title={item.title} disabled={loading} onClick={() => void mark(item)} className="flex min-h-10 w-full items-center gap-3 rounded-[var(--radius-md)] px-2 text-left hover:bg-[var(--color-surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${item.readAt ? 'invisible' : 'bg-[var(--color-brand)]'}`} />
            <span className={`truncate text-[13px] ${item.readAt ? 'text-[var(--color-text-secondary)]' : 'font-semibold'}`}>{item.title}</span>
            {!item.readAt && <span className="sr-only">{t('rail.unread')}</span>}
          </button>
        </li>)}
      </ul>
      {cursor && <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load(cursor)}>{t('rail.more')}</Button>}
    </>}
  </div>
}
