import { useEffect, useId, useRef, useState } from 'react'
import { PanelLeftOpen, RefreshCw, X } from 'lucide-react'
import chatIcon from '@/assets/sidebar/rail-chat.png'
import canvasIcon from '@/assets/sidebar/rail-canvas.png'
import noticesIcon from '@/assets/sidebar/rail-announcements.png'
import settingsIcon from '@/assets/sidebar/rail-settings.png'
import accountIcon from '@/assets/sidebar/rail-account.png'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { RailAnnouncements } from '@/components/layout/RailAnnouncements'
import { useDismissable } from '@/hooks/useDismissable'
import { useRailAccount } from '@/hooks/useRailAccount'
import { useTranslation } from '@/i18n'
import { getDesktopHost, type AccountSummary, type DesktopHost } from '@/lib/desktopHost'
import { getTabLastViewed, SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useProviderStore } from '@/stores/providerStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUIStore } from '@/stores/uiStore'

function RailArtwork({ src }: { src: string }) {
  return <span aria-hidden="true" className="inline-block size-5 shrink-0 bg-current" style={{ mask: `url("${src}") center / contain no-repeat` }} />
}

function RechargeButton() {
  const t = useTranslation()
  const errorId = useId()
  const [failed, setFailed] = useState(false)
  const open = async () => {
    setFailed(false)
    try {
      await getDesktopHost().shell.open('https://ai.3zapi.com/purchase')
    } catch {
      setFailed(true)
    }
  }
  return <>
    <Button size="sm" variant="secondary" title={t('rail.rechargeInBrowser')} aria-describedby={failed ? errorId : undefined} onClick={open}>{t('rail.recharge')}</Button>
    {failed && <p role="alert" id={errorId} className="w-full text-xs text-[var(--color-error)]">{t('rail.rechargeFailed')}</p>}
  </>
}

function SummaryRows({ api, userId }: { api: DesktopHost['account']; userId: string }) {
  const t = useTranslation()
  const [value, setValue] = useState<AccountSummary | 'insufficient-scope' | null>(null)
  const needsConsent = value === 'insufficient-scope'
  const summary = needsConsent ? null : value
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const result = await api.getSummary()
        if (!active) return
        if (result.ok) setValue(result.data.userId === userId ? result.data : null)
        else setValue(result.error.code === 'insufficient-scope' ? 'insufficient-scope' : null)
      } catch {
        if (active) setValue(null)
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [api, userId, revision])
  const current = summary?.concurrencyCurrent
  const limit = summary?.concurrencyLimit
  return <>
    <SettingsGroup className="tabular-nums">
      <SettingsRow layout="inline" title={t('rail.pointsBalance')}><span><span aria-hidden="true">✪ </span>{summary?.points ?? '—'}</span></SettingsRow>
      <SettingsRow layout="inline" title={t('rail.concurrency')}><span>{current == null && limit == null ? '—' : `${current ?? '—'} / ${limit ?? '—'}`}</span></SettingsRow>
      <SettingsRow layout="inline" title={t('rail.todayTokens')}><span>{summary?.todayTokens ?? '—'}</span></SettingsRow>
      <SettingsRow layout="inline" title={t('rail.todayRequests')}><span>{summary?.todayRequests ?? '—'}</span></SettingsRow>
    </SettingsGroup>
    {needsConsent && <p role="alert" className="text-[13px] text-[var(--color-text-secondary)]">{t('rail.summarySignInAgain')}</p>}
    <IconButton size="sm" icon={<RefreshCw />} label={t('rail.refreshSummary')} loading={loading} onClick={() => { setLoading(true); setRevision(n => n + 1) }} />
  </>
}

export function DesktopNavigationRail() {
  const t = useTranslation()
  const host = getDesktopHost()
  const api = host.isDesktop ? host.account : undefined
  const account = useRailAccount(api)
  const profile = account.status?.authenticated ? account.status.profile : undefined
  const configured = account.status?.modelSetup === 'ready' ? profile?.id : undefined
  const previousConfigured = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (previousConfigured.current !== configured) void useProviderStore.getState().fetchProviders()
    previousConfigured.current = configured
  }, [configured])
  const [panel, setPanel] = useState<'announcements' | 'account' | 'canvas' | null>(null)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const activeSettings = useUIStore((s) => s.activeSettingsTab)
  const activeId = useTabStore((s) => s.activeTabId)
  const isChat = useTabStore((s) => !s.activeTabId || s.tabs.some((tab) => tab.type === 'session' && tab.sessionId === s.activeTabId))
  const lastChat = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    // An uninitialized shell starts at null before restoring its tabs. Don't
    // mistake that transient home for a draft the user visited.
    if (isChat && (activeId !== null || lastChat.current !== undefined || useTabStore.getState().tabs.length)) lastChat.current = activeId
  }, [activeId, isChat])
  const chat = () => {
    const { tabs, setActiveTab } = useTabStore.getState()
    const previous = lastChat.current
    // null is a destination too: return to the retained unsent composer, even
    // if an older conversation is also open in a tab.
    if (previous === null || tabs.some((tab) => tab.type === 'session' && tab.sessionId === previous)) {
      setActiveTab(previous ?? null)
      return
    }
    const open = tabs.filter((tab) => tab.type === 'session')
    const recent = open.find((tab) => tab.sessionId === useSessionStore.getState().activeSessionId)
      ?? open.sort((a, b) => getTabLastViewed(b.sessionId) - getTabLastViewed(a.sessionId))[0]
    setActiveTab(recent?.sessionId ?? null)
  }
  const settings = () => {
    if (host.isDesktop && activeSettings === 'h5Access') {
      useUIStore.getState().setPendingSettingsTab(null)
      useUIStore.getState().setActiveSettingsTab('general')
    }
    useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }
  const noticeRef = useRef<HTMLButtonElement>(null)
  const accountRef = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const popoverOpen = panel === 'account' || panel === 'announcements'
  const trigger = panel === 'announcements' ? noticeRef : accountRef
  const close = (returnFocus = true) => {
    setPanel(null)
    if (returnFocus) trigger.current?.focus()
  }
  useDismissable({ open: popoverOpen, refs: [popover, noticeRef, accountRef], onDismiss: (reason) => close(reason === 'escape') })
  useEffect(() => {
    if (popoverOpen) popover.current?.focus()
  }, [popoverOpen, panel])
  const open = (next: 'account' | 'announcements') => {
    if (panel === next) close()
    else { setPanel(next); void account.refresh() }
  }
  const waiting = account.busy === 'login' || account.status?.status === 'authorizing'
  const unavailable = !api || account.status?.status === 'unavailable'
  const unread = profile ? account.status?.unreadCount : undefined
  const noticeLabel = unread ? t('rail.unreadCount', { count: unread }) : t('rail.announcements')
  return <nav aria-label={t('rail.navigation')} data-testid="desktop-navigation-rail" data-mac={host.isDesktop && /Mac/.test(navigator.platform)} className="desktop-navigation-rail">
    <IconButton icon={<RailArtwork src={chatIcon} />} label={t('rail.chat')} pressed={isChat && !panel} onClick={() => { setPanel(null); chat() }} />
    <IconButton icon={<RailArtwork src={canvasIcon} />} label={t('rail.canvas')} pressed={panel === 'canvas'} onClick={() => setPanel('canvas')} />
    {!sidebarOpen && <IconButton icon={<PanelLeftOpen />} label={t('sidebar.expand')} aria-controls="sidebar-shell" onClick={() => useUIStore.getState().setSidebarOpen(true)} />}
    <div className="mt-auto flex flex-col items-center gap-1">
      <div className="relative">
        <IconButton ref={noticeRef} icon={<RailArtwork src={noticesIcon} />} label={noticeLabel} aria-expanded={panel === 'announcements'} aria-haspopup="dialog" onClick={() => open('announcements')} />
        {!!unread && <span className="desktop-rail-unread" aria-hidden="true" />}
      </div>
      <IconButton icon={<RailArtwork src={settingsIcon} />} label={t('sidebar.settings')} pressed={!panel && activeId === SETTINGS_TAB_ID && !(host.isDesktop && activeSettings === 'h5Access')} onClick={() => { setPanel(null); settings() }} />
      <IconButton ref={accountRef} icon={<RailArtwork src={accountIcon} />} label={profile?.displayName || t('rail.login')} aria-expanded={panel === 'account'} aria-haspopup="dialog" onClick={() => open('account')} />
    </div>
    {popoverOpen && <div ref={popover} tabIndex={-1} role="dialog" aria-label={t(panel === 'account' ? 'rail.account' : 'rail.announcements')} className="desktop-rail-popover" data-panel={panel}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{t(panel === 'account' ? 'rail.account' : 'rail.announcements')}</h2>
        <IconButton size="sm" icon={<X />} label={t('common.close')} onClick={() => close()} />
      </header>
      {account.error && <p role="alert" className="mb-2 text-[13px] text-[var(--color-error)]">{t(account.error)}</p>}
      {!account.status ? <p role="status">{t('common.loading')}</p> : unavailable ? <>
        {!account.error && <p role="alert">{t('rail.serviceUnavailable')}</p>}
        {api && <Button size="sm" variant="secondary" onClick={() => void account.refresh()}>{t('common.retry')}</Button>}
      </> : profile && panel === 'announcements' && api ? <RailAnnouncements key={profile.id} api={api} unreadCount={unread} onRead={account.refresh} onExpired={account.expire} />
        : profile ? <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--color-brand-soft)] text-[15px] font-semibold text-[var(--color-on-brand-soft)]">{Array.from(profile.displayName.trim() || profile.id)[0]?.toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{profile.displayName.trim() || profile.id}</p>
              {profile.email && <p className="truncate text-xs text-[var(--color-text-tertiary)]">{profile.email}</p>}
            </div>
            <RechargeButton key={profile.id} />
          </div>
          {api && account.status.status === 'signed-in' && account.busy !== 'logout' && <SummaryRows key={profile.id} api={api} userId={profile.id} />}
          {account.status.modelSetup === 'failed' && <div className="space-y-1"><p role="status">{t('rail.modelSetupFailed')}</p><Button size="sm" variant="secondary" onClick={() => void account.refresh()}>{t('common.retry')}</Button></div>}
          <Button size="sm" variant="secondary" loading={account.busy === 'logout'} onClick={() => void account.act('signOut')}>{t('rail.signOut')}</Button>
        </div> : <div className="space-y-3">
          <p>{t(waiting ? 'rail.waiting' : 'rail.guestPrompt')}</p>
          <div className="flex flex-wrap gap-2">
            {waiting ? <Button size="sm" variant="secondary" onClick={() => void account.act('cancelLogin')}>{t('common.cancel')}</Button>
              : panel === 'announcements' ? <Button size="sm" onClick={() => open('account')}>{t('rail.login')}</Button>
                : <Button size="sm" onClick={() => void account.act('beginLogin')}>{t('rail.loginWithBrowser')}</Button>}
            {!waiting && panel === 'account' && <Button size="sm" variant="secondary" onClick={() => close()}>{t('rail.later')}</Button>}
          </div>
        </div>}
    </div>}
    <Modal open={panel === 'canvas'} onClose={() => setPanel(null)} title={t('rail.canvas')} width={360} footer={<Button size="sm" onClick={() => setPanel(null)}>{t('common.close')}</Button>}>
      <p className="text-sm text-[var(--color-text-secondary)]">{t('rail.comingSoon')}</p>
    </Modal>
  </nav>
}
