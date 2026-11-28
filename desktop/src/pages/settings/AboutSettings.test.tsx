import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUpdateStore } from '@/stores/updateStore'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { AboutSettings } from './AboutSettings'

const initialSettingsState = useSettingsStore.getState()
const initialUpdateState = useUpdateStore.getState()

async function renderAboutSettings(updates = false) {
  window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true, capabilities: { ...browserHost.capabilities, updates } }
  render(<AboutSettings />)
  await screen.findByText('版本 0.1.0')
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'zh', autoUpdateEnabled: true })
  useUpdateStore.setState({
    status: 'idle', availableVersion: null, error: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'desktopHost')
  useSettingsStore.setState(initialSettingsState)
  useUpdateStore.setState(initialUpdateState)
  vi.restoreAllMocks()
})

it('requires separate check and install clicks even with the old automatic preference enabled', async () => {
  await renderAboutSettings(true)
  const actions = useUpdateStore.getState()
  expect(actions.initialize).not.toHaveBeenCalled()
  expect(actions.checkForUpdates).not.toHaveBeenCalled()
  expect(screen.queryByRole('switch', { name: '自动更新' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
  expect(actions.checkForUpdates).toHaveBeenCalledWith({ autoDownload: false })
  act(() => useUpdateStore.setState({ status: 'available', availableVersion: '0.2.0' }))
  expect(actions.installUpdate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '立即更新' }))
  expect(actions.installUpdate).toHaveBeenCalledOnce()
})

it('offers a retry rather than reporting current version when the feed is unavailable', async () => {
  useUpdateStore.setState({ status: 'error', error: 'missing release manifest' })
  await renderAboutSettings(true)
  expect(screen.getByRole('alert')).toHaveTextContent(/请稍后重试/)
  expect(screen.queryByText(/已是最新/)).toBeNull()
  expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled()
})

it('does not offer or check for updates on an unsupported host', async () => {
  await renderAboutSettings()
  expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull()
  expect(useUpdateStore.getState().initialize).not.toHaveBeenCalled()
  expect(useUpdateStore.getState().checkForUpdates).not.toHaveBeenCalled()
})

it('names the product 落叶AI and links to the 落叶AI website', async () => {
  const open = vi.spyOn(browserHost.shell, 'open').mockResolvedValue(undefined)
  await renderAboutSettings()
  expect(screen.getByText('落叶AI')).toBeInTheDocument()
  expect(screen.queryByText('Claude Code Haha')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /落叶AI 官网/ }))
  expect(open).toHaveBeenCalledWith('https://cn-api.3zapi.com')
})

it('shows the upstream attribution and the concise modification notice without sign-in', async () => {
  const open = vi.spyOn(browserHost.shell, 'open').mockResolvedValue(undefined)
  await renderAboutSettings()
  const attribution = screen.getByRole('button', { name: /Based on cc-haha: https:\/\/github\.com\/NanmiCoder\/cc-haha/ })
  expect(attribution).toHaveTextContent('Copyright (c) 2026 cc-haha')
  fireEvent.click(attribution)
  expect(open).toHaveBeenCalledWith('https://github.com/NanmiCoder/cc-haha')
  expect(screen.getByText('本软件为 cc-haha 的修改版。')).toBeVisible()
  expect(screen.getByText('主要改动：落叶AI 品牌、GPT 与 Claude 密钥配置、余额显示。')).toBeVisible()
})

it('drops the upstream promotion rows: star, issues, community group, changelog, author and social links', async () => {
  await renderAboutSettings()
  expect(document.querySelector('img[src*="wechat-group-qr"]')).toBeNull()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('NanmiCoder/cc-haha')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /反馈问题/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /交流群/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '更新日志' })).not.toBeInTheDocument()
  expect(screen.queryByText('程序员阿江-Relakkes')).not.toBeInTheDocument()
})
