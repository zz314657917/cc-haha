import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopNavigationRail } from '@/components/layout/DesktopNavigationRail'
import { browserHost } from '@/lib/desktopHost/browserHost'
import type { AccountResult, AccountStatus, DesktopHost } from '@/lib/desktopHost'
import { useSettingsStore } from '@/stores/settingsStore'
import { SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'

const guest: AccountStatus = { status: 'signed-out', authenticated: false }
const user = (id: string): AccountStatus => ({ status: 'signed-in', authenticated: true, profile: { id, displayName: id }, unreadCount: 1 })
const ok = <T,>(data: T): AccountResult<T> => ({ ok: true, data })
const button = (name: string | RegExp) => screen.getByRole('button', { name })
function mount(overrides: Partial<DesktopHost['account']> = {}, open = vi.fn<DesktopHost['shell']['open']>()) {
  const account = {
    ...browserHost.account,
    getStatus: vi.fn(async () => ok(guest)), listAnnouncements: vi.fn(async () => ok({ items: [] })),
    ...overrides,
  }
  window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true, account, shell: { ...browserHost.shell, open } }
  render(<DesktopNavigationRail />)
  return account
}
beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useTabStore.setState({ tabs: [], activeTabId: null })
  useUIStore.setState({ sidebarOpen: false, activeSettingsTab: 'general' })
})
afterEach(() => { Reflect.deleteProperty(window, 'desktopHost') })

describe('desktop navigation rail', () => {
  it('shows the five generated icons in the narrow desktop rail without changing button names', async () => {
    await act(async () => { mount() })
    for (const [label, asset] of [['Chat', 'chat'], ['Infinite canvas', 'canvas'], ['Announcements', 'announcements'], ['Settings', 'settings'], ['Sign in', 'account']] as const) {
      expect(button(label).querySelector<HTMLElement>('[style*="mask"]')?.style.mask).toContain(`rail-${asset}.png`)
    }
  })

  it('returns to the last chat or draft rather than creating a session; canvas does not replace either', async () => {
    useTabStore.getState().openTab('a', 'First')
    useTabStore.getState().openTab('b', 'Last')
    await act(async () => { mount() })
    fireEvent.click(button('Settings'))
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    fireEvent.click(button('Chat'))
    expect(useTabStore.getState().activeTabId).toBe('b')
    act(() => useTabStore.getState().setActiveTab(null))
    fireEvent.click(button('Settings'))
    fireEvent.click(button('Chat'))
    expect(useTabStore.getState().activeTabId).toBeNull()
    fireEvent.click(button('Infinite canvas'))
    expect(screen.getByText('Coming soon')).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useTabStore.getState().tabs.map((tab) => tab.sessionId)).toEqual(['a', 'b', SETTINGS_TAB_ID])
    fireEvent.click(button('Expand sidebar'))
    expect(useUIStore.getState().sidebarOpen).toBe(true)
  })

  it('does not show a feed or badge for a guest; restores focus on Escape and supports skipping login', async () => {
    const api = mount()
    const notices = button('Announcements')
    fireEvent.click(notices)
    const dialog = await screen.findByRole('dialog', { name: 'Announcements' })
    expect(await within(dialog).findByText(/You can chat without signing in/)).toBeVisible()
    expect(api.listAnnouncements).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(notices).toHaveFocus()
    await act(async () => { fireEvent.click(button('Sign in')) })
    fireEvent.click(button('Not now'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('invokes browser login, permits cancelling an in-flight attempt, and never reads the feed while logged out', async () => {
    let finish!: (result: AccountResult<void>) => void
    const beginLogin = vi.fn(() => new Promise<AccountResult<void>>((resolve) => { finish = resolve }))
    const cancelLogin = vi.fn(async () => { finish({ ok: false, error: { code: 'cancelled', message: '' } }); return ok(undefined) })
    mount({ beginLogin, cancelLogin })
    fireEvent.click(button('Sign in'))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with your browser' }))
    fireEvent.click(button('Cancel'))
    expect(cancelLogin).toHaveBeenCalledTimes(1)
    await screen.findByRole('button', { name: 'Sign in with your browser' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uses the signed-in identity, marks unknown metrics, and opens only the fixed recharge page on click', async () => {
    const open = vi.fn<DesktopHost['shell']['open']>().mockRejectedValueOnce(new Error('private diagnostic')).mockResolvedValue(undefined)
    mount({ getStatus: async () => ok({ ...user('acct-42'), profile: { id: 'acct-42', displayName: '夏 Yu', email: 'yu@example.test' } }) }, open)
    fireEvent.click(await screen.findByRole('button', { name: '夏 Yu' }))
    const card = within(screen.getByRole('dialog', { name: 'Luoye AI account' }))
    expect(card.getByText('夏')).toBeVisible()
    expect(card.getByText('夏 Yu')).toBeVisible()
    expect(card.getByText('yu@example.test')).toBeVisible()
    for (const label of ['Points balance', 'Current concurrency', 'Today’s token usage']) expect(card.getByText(label)).toBeVisible()
    expect(card.getByText('✪')).toBeVisible()
    expect(card.getAllByText('—')).toHaveLength(4)
    const recharge = card.getByRole('button', { name: 'Recharge' })
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(recharge)
    expect(open.mock.calls).toEqual([['https://ai.3zapi.com/purchase']])
    const alert = await card.findByRole('alert')
    expect(alert).toHaveTextContent('Could not open the recharge page.')
    expect(recharge).toHaveAccessibleDescription(alert.textContent!)
    fireEvent.click(recharge)
    await waitFor(() => expect(card.queryByRole('alert')).toBeNull())
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('fetches summary only for an open signed-in account, on opening and manual refresh', async () => {
    let status = guest
    const data = { userId: '42', points: 0, concurrencyCurrent: 0, concurrencyLimit: null, todayTokens: null, todayRequests: 8 }
    const getSummary = vi.fn<DesktopHost['account']['getSummary']>().mockResolvedValueOnce(ok(data)).mockResolvedValueOnce(ok({ ...data, userId: '43', points: 999 }))
    mount({ getStatus: async () => ok(status), getSummary })
    await act(async () => { fireEvent.click(button('Sign in')) })
    expect(getSummary).not.toHaveBeenCalled()
    fireEvent.click(button('Not now'))
    status = user('42')
    await act(async () => { fireEvent.focus(window) })
    await act(async () => { fireEvent.click(button(/1 unread/)) })
    expect(getSummary).not.toHaveBeenCalled()
    fireEvent.click(button('42'))
    expect(await screen.findByText('0 / —')).toBeVisible()
    expect(screen.getByText('0')).toHaveTextContent('✪ 0')
    expect(screen.getByText('8')).toBeVisible()
    await act(async () => { fireEvent.focus(window) })
    expect(getSummary).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(button('Refresh account summary')) })
    expect(getSummary).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.queryByText('999')).toBeNull()
    expect(button('Sign out')).toBeVisible()
  })

  it('guides a legacy user through explicit sign-out and sign-in to see summary values', async () => {
    let status = user('42')
    const getSummary = vi.fn<DesktopHost['account']['getSummary']>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'insufficient-scope', message: 'private diagnostic' } })
      .mockResolvedValueOnce(ok({ userId: '42', points: 0, concurrencyCurrent: 0, concurrencyLimit: 0, todayTokens: 0, todayRequests: 0 }))
    const signOut = vi.fn(async () => { status = guest; return ok(undefined) })
    const beginLogin = vi.fn(async () => { status = user('42'); return ok(undefined) })
    mount({ getStatus: async () => ok(status), getSummary, signOut, beginLogin })
    fireEvent.click(await screen.findByRole('button', { name: '42' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('To view your account summary, sign out and sign in again.')
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(signOut).not.toHaveBeenCalled()
    fireEvent.click(button('Sign out'))
    const login = await screen.findByRole('button', { name: 'Sign in with your browser' })
    expect(beginLogin).not.toHaveBeenCalled()
    fireEvent.click(login)
    expect(await screen.findByText('0 / 0')).toBeVisible()
    expect(screen.getAllByText('0')).toHaveLength(3)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a late summary from a previous panel after switching accounts', async () => {
    let identity = '42'
    const data = { userId: identity, points: 123, concurrencyCurrent: null, concurrencyLimit: null, todayTokens: null, todayRequests: null }
    let finish!: (value: AccountResult<typeof data>) => void
    const getSummary = vi.fn<DesktopHost['account']['getSummary']>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(ok({ ...data, userId: '43', points: 456 }))
    mount({ getStatus: async () => ok(user(identity)), getSummary })
    fireEvent.click(await screen.findByRole('button', { name: '42' }))
    identity = '43'
    fireEvent.focus(window)
    expect(await screen.findByText('456')).toBeVisible()
    await act(async () => finish(ok(data)))
    expect(screen.getByText('456')).toBeVisible()
    expect(screen.queryByText('123')).toBeNull()
  })

  it('shows ten notices after login, updates the unread count, and hides the feed on logout', async () => {
    let signedIn = false
    const read = new Set<string>()
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1))
    mount({
      getStatus: async () => ok(signedIn ? { ...user('Demo'), unreadCount: ids.length - read.size } : guest),
      beginLogin: async () => { signedIn = true; return ok(undefined) },
      signOut: async () => { signedIn = false; return ok(undefined) },
      listAnnouncements: async () => ok({ items: ids.map(id => ({ id, title: `Notice ${id}`, body: `Body ${id}`, publishedAt: '2026-11-25', readAt: read.has(id) ? '2026-11-25' : undefined })) }),
      markAnnouncementRead: async ({ id }) => { read.add(id); return ok(undefined) },
      markAllAnnouncementsRead: async () => { ids.forEach(id => read.add(id)); return ok(undefined) },
    })
    fireEvent.click(button('Sign in'))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with your browser' }))
    expect(await screen.findByText('Demo')).toBeVisible()
    fireEvent.click(button(/10 unread/))
    expect(await screen.findAllByRole('listitem')).toHaveLength(10)
    fireEvent.click(button(/Notice 10/))
    expect(await screen.findByText('Body 10')).toBeVisible()
    expect(await screen.findByRole('button', { name: /9 unread/ })).toBeInTheDocument()
    fireEvent.click(button('Back to announcements'))
    fireEvent.click(button('Mark all as read'))
    await waitFor(() => expect(screen.queryByText('Unread')).not.toBeInTheDocument())
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    fireEvent.click(button('Demo'))
    fireEvent.click(button('Sign out'))
    await screen.findByRole('button', { name: 'Sign in with your browser' })
    fireEvent.click(button('Announcements'))
    expect(await screen.findByText(/You can chat without signing in/)).toBeVisible()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('invalidates the old account feed even if a prior request arrives after switching accounts', async () => {
    let identity = 'Alice'
    let resolve!: (value: AccountResult<{ items: { id: string; title: string; publishedAt: string }[] }>) => void
    const delayed = new Promise<AccountResult<{ items: { id: string; title: string; publishedAt: string }[] }>>((r) => { resolve = r })
    const list = vi.fn(() => identity === 'Alice' ? delayed : Promise.resolve(ok({ items: [{ id: '2', title: 'For Bob', publishedAt: '' }] })))
    mount({ getStatus: async () => ok(user(identity)), listAnnouncements: list })
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/ }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    identity = 'Bob'
    fireEvent.focus(window)
    await screen.findByText('For Bob')
    await act(async () => resolve(ok({ items: [{ id: '1', title: 'For Alice', publishedAt: '' }] })))
    expect(screen.queryByText('For Alice')).toBeNull()
    expect(screen.getByText('For Bob')).toBeVisible()
  })

  it('clears private notices on expiry and shows localized offline and unavailable errors', async () => {
    let network = false
    mount({ getStatus: async () => network ? { ok: false, error: { code: 'network', message: 'private diagnostic' } } : ok(user('Alice')),
      listAnnouncements: async () => ({ ok: false, error: { code: 'unauthorized', message: 'raw' } }) })
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/)
    expect(screen.queryByRole('button', { name: 'Alice' })).toBeNull()
    network = true
    fireEvent.focus(window)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/connection/))
    expect(screen.queryByText('private diagnostic')).toBeNull()
  })

  it('gates account actions in a desktop browser while preserving navigation', async () => {
    render(<DesktopNavigationRail />)
    fireEvent.click(button('Sign in'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/)
    expect(screen.queryByRole('button', { name: 'Sign in with your browser' })).toBeNull()
    fireEvent.click(button('Settings'))
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
  })
})
