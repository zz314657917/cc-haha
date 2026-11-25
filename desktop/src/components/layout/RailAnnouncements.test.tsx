import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import { RailAnnouncements } from '@/components/layout/RailAnnouncements'
import { browserHost } from '@/lib/desktopHost/browserHost'
import type { AccountAnnouncement, AccountResult } from '@/lib/desktopHost'
import { useSettingsStore } from '@/stores/settingsStore'

const ok = <T,>(data: T): AccountResult<T> => ({ ok: true, data })
describe('account announcement list', () => {
  it('reads the detail as plain text, marks only that item then marks the remaining items, using confirmed server state', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const notices: AccountAnnouncement[] = ['First', 'Second'].map((title, id) => ({ id: `${id}`, title, body: `<b>${title}</b>`, publishedAt: '2026-11-20' }))
    const api = {
      ...browserHost.account,
      listAnnouncements: vi.fn(async () => ok({ items: notices.map((item) => ({ ...item })) })),
      markAnnouncementRead: vi.fn(async ({ id }: { id: string }) => { notices[Number(id)]!.readAt = 'today'; return ok(undefined) }),
      markAllAnnouncementsRead: vi.fn(async () => { for (const item of notices) item.readAt = 'today'; return ok(undefined) }),
    }
    render(<RailAnnouncements api={api} onRead={vi.fn()} onExpired={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /First/ }))
    expect(api.markAnnouncementRead).toHaveBeenCalledWith({ id: '0' })
    expect(screen.getByText('<b>First</b>')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Back to announcements' }))
    await waitFor(() => expect(screen.getAllByText('Unread')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    await waitFor(() => expect(screen.queryByText('Unread')).toBeNull())
    expect(api.markAllAnnouncementsRead).toHaveBeenCalledTimes(1)
  })

  it('keeps summaries out of the list but shows them when a notice has no full body', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const notice = { id: '1', title: 'New models', summary: 'See the updated catalog.', publishedAt: '', readAt: 'today' }
    render(<RailAnnouncements api={{ ...browserHost.account, listAnnouncements: async () => ok({ items: [notice] }) }} onRead={vi.fn()} onExpired={vi.fn()} />)
    const row = await screen.findByRole('button', { name: /New models/ })
    expect(row).toHaveAccessibleName('New models')
    expect(screen.queryByText(notice.summary)).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(await screen.findByText(notice.summary)).toBeVisible()
  })

  it('does not render a failed list as empty and can refresh to the real empty state', async () => {
    useSettingsStore.setState({ locale: 'en' })
    const list = vi.fn<typeof browserHost.account.listAnnouncements>().mockResolvedValueOnce({ ok: false, error: { code: 'network', message: 'diagnostic' } }).mockResolvedValueOnce(ok({ items: [] }))
    render(<RailAnnouncements api={{ ...browserHost.account, listAnnouncements: list }} onRead={vi.fn()} onExpired={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach')
    expect(screen.queryByText('No announcements for this account.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh announcements' }))
    expect(await screen.findByText('No announcements for this account.')).toBeVisible()
  })
})
