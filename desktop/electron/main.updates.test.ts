import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 落叶AI is a fork of cc-haha. The update feed electron-updater would read is
// upstream's GitHub Releases, and installing one replaces this client with
// upstream cc-haha. These checks keep the host from ever reaching that feed.
const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')
const updaterServiceSource = mainSource.slice(
  mainSource.indexOf('function getUpdaterService()'),
  mainSource.indexOf('function nodePtyRuntimeCacheDir()'),
)

describe('Electron host app updates', () => {
  it('ships with updates disabled', () => {
    expect(mainSource).toMatch(/^const UPDATES_ENABLED = false$/m)
  })

  it('answers checks from the disabled updater before electron-updater is touched', () => {
    const disabledBranch = updaterServiceSource.indexOf('if (!UPDATES_ENABLED && !smokeUpdater)')
    const firstAutoUpdaterUse = updaterServiceSource.indexOf('autoUpdater')

    expect(disabledBranch).toBeGreaterThan(-1)
    expect(firstAutoUpdaterUse).toBeGreaterThan(disabledBranch)
    expect(updaterServiceSource).toContain('new ElectronUpdaterService(disabledUpdater)')
  })

  it('routes every update IPC handler through getUpdaterService', () => {
    // A handler that reached autoUpdater directly would bypass the switch.
    const outsideUpdaterService = mainSource.replace(updaterServiceSource, '')
    expect(outsideUpdaterService).not.toMatch(/autoUpdater\.(?:checkForUpdates|downloadUpdate|quitAndInstall)/)
  })
})
