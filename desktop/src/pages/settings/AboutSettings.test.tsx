import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUpdateStore } from '@/stores/updateStore'
import { settingsApi } from '@/api/settings'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { AboutSettings, AboutUpdatesSection } from './AboutSettings'

const initialSettingsState = useSettingsStore.getState()
const initialUpdateState = useUpdateStore.getState()

async function renderAboutSettings() {
  render(<AboutSettings />)
  await screen.findByText('版本 0.1.0')
}

// The update controls are hidden in this build (APP_UPDATES_ENABLED is off),
// but they are kept working for a future 落叶AI update feed.
async function renderUpdatesSection() {
  render(<AboutUpdatesSection version="0.1.0" />)
  await screen.findByText('0.1.0')
}

beforeEach(async () => {
  useSettingsStore.setState({ locale: 'zh', autoUpdateEnabled: true })
  useUpdateStore.setState({
    status: 'idle',
    availableVersion: null,
    error: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    installUpdate: vi.fn().mockResolvedValue(undefined),
  })
  vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  // Establish the persisted fixture as well as the optimistic store value;
  // failed saves must roll back to a successful save, not an arbitrary setState.
  await useSettingsStore.getState().setAutoUpdateEnabled(true)
  vi.mocked(settingsApi.updateUser).mockClear()
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettingsState)
  useUpdateStore.setState(initialUpdateState)
  vi.restoreAllMocks()
})

it('shows automatic updates enabled by default with the scope of the setting', async () => {
  await renderUpdatesSection()
  expect(screen.getByRole('switch', { name: '自动更新' })).toBeChecked()
  expect(screen.getByText('自动检查新版本并在后台下载；关闭后仍可手动检查与安装。')).toBeInTheDocument()
})

it('saves automatic updates off and back on through the settings API', async () => {
  await renderUpdatesSection()
  const toggle = screen.getByRole('switch', { name: '自动更新' })
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(settingsApi.updateUser).toHaveBeenCalledWith({ autoUpdateEnabled: false })

  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(settingsApi.updateUser).toHaveBeenLastCalledWith({ autoUpdateEnabled: true })
})

it('disables the switch until saving finishes', async () => {
  let finishSave: (result: { ok: true }) => void = () => {}
  vi.mocked(settingsApi.updateUser).mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve }))
  await renderUpdatesSection()
  const toggle = screen.getByRole('switch', { name: '自动更新' })
  fireEvent.click(toggle)
  expect(toggle).toBeDisabled()
  await waitFor(() => expect(settingsApi.updateUser).toHaveBeenCalledOnce())
  await act(async () => { finishSave({ ok: true }) })
  expect(toggle).toBeEnabled()
  expect(toggle).not.toBeChecked()
})

it('surfaces a failed save and restores the previous automatic update setting', async () => {
  vi.mocked(settingsApi.updateUser).mockRejectedValueOnce(new Error('fixture save failed'))
  await renderUpdatesSection()
  const toggle = screen.getByRole('switch', { name: '自动更新' })
  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('自动更新设置保存失败：fixture save failed')
  expect(toggle).toBeChecked()
  expect(toggle).toBeEnabled()
})

it('keeps manual checking and installing available while automatic updates are off', async () => {
  useSettingsStore.setState({ autoUpdateEnabled: false })
  useUpdateStore.setState({ status: 'downloaded', availableVersion: '0.2.0' })
  await renderUpdatesSection()
  expect(screen.getByRole('switch', { name: '自动更新' })).not.toBeChecked()
  expect(useUpdateStore.getState().initialize).not.toHaveBeenCalled()
  const check = screen.getByRole('button', { name: '检查更新' })
  const install = screen.getByRole('button', { name: '安装并重启' })
  expect(check).toBeEnabled()
  expect(install).toBeEnabled()
  fireEvent.click(check)
  fireEvent.click(install)
  expect(useUpdateStore.getState().checkForUpdates).toHaveBeenCalledOnce()
  expect(useUpdateStore.getState().installUpdate).toHaveBeenCalledOnce()
  expect(screen.getByText('更新已下载。点击「安装并重启」后应用新版。')).toBeInTheDocument()
})

it('names the product 落叶AI and links to the 落叶AI website', async () => {
  const open = vi.spyOn(browserHost.shell, 'open').mockResolvedValue(undefined)
  await renderAboutSettings()

  expect(screen.getByText('落叶AI')).toBeInTheDocument()
  expect(screen.queryByText('Claude Code Haha')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /落叶AI 官网/ }))
  expect(open).toHaveBeenCalledWith('https://cn-api.3zapi.com')
})

// The cc-haha license (section 4) requires a visible attribution with a working
// link on the About page, and a notice that this build is modified and unofficial.
it('shows the upstream attribution and the unofficial-modification notice', async () => {
  const open = vi.spyOn(browserHost.shell, 'open').mockResolvedValue(undefined)
  await renderAboutSettings()

  const attribution = screen.getByRole('button', { name: /Based on cc-haha: https:\/\/github\.com\/NanmiCoder\/cc-haha/ })
  expect(attribution).toHaveTextContent('Copyright (c) 2026 cc-haha')
  fireEvent.click(attribution)
  expect(open).toHaveBeenCalledWith('https://github.com/NanmiCoder/cc-haha')

  const notice = screen.getByText(/cc-haha 的修改版，非官方发行版本/)
  expect(notice).toHaveTextContent('内置落叶AI 服务商')
  expect(notice).toHaveTextContent('首次启动 API Key 设置')
  expect(notice).toHaveTextContent('余额显示')
  expect(notice).toHaveTextContent('品牌更名')
})

it('drops the upstream promotion rows: star, issues, community group, changelog, author and social links', async () => {
  await renderAboutSettings()

  expect(screen.queryByText('NanmiCoder/cc-haha')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /反馈问题/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /交流群/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '更新日志' })).not.toBeInTheDocument()
  expect(screen.queryByText('程序员阿江-Relakkes')).not.toBeInTheDocument()
})

// The upstream feed is NanmiCoder/cc-haha's GitHub Releases; an install from
// it would replace this fork. The page must neither offer nor start a check.
it('hides the update controls and never starts an update check', async () => {
  await renderAboutSettings()

  expect(screen.queryByText('应用更新')).not.toBeInTheDocument()
  expect(screen.queryByRole('switch', { name: '自动更新' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument()
  expect(useUpdateStore.getState().initialize).not.toHaveBeenCalled()
  expect(useUpdateStore.getState().checkForUpdates).not.toHaveBeenCalled()
})
