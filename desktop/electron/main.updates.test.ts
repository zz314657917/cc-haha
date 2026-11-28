import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { supportsWindowsStableUpdates, LUOYE_UPDATE_FEED } from './services/updater'

const root = existsSync(path.resolve('electron/main.ts')) ? process.cwd() : path.resolve('desktop')
const main = readFileSync(path.join(root, 'electron/main.ts'), 'utf8')
const factory = main.slice(main.indexOf('function getUpdaterService()'), main.indexOf('function nodePtyRuntimeCacheDir()'))

describe('manual Windows updates', () => {
  it('only enables release builds on packaged Windows', () => {
    expect(supportsWindowsStableUpdates(true, 'win32', '0.8.0')).toBe(true)
    expect(supportsWindowsStableUpdates(true, 'win32', '0.8.0-beta.1')).toBe(false)
    expect(supportsWindowsStableUpdates(false, 'win32', '0.8.0')).toBe(false)
    expect(supportsWindowsStableUpdates(true, 'darwin', '0.8.0')).toBe(false)
    expect(supportsWindowsStableUpdates(true, 'linux', '0.8.0')).toBe(false)
  })

  it('does not access the real updater in unsupported or offline smoke environments', () => {
    const fake = { checkForUpdates: vi.fn() }
    const context = {
      process: { env: {} }, updaterService: null, supportsManualUpdates: () => false,
      createUpdateSmokeUpdaterFromEnv: vi.fn().mockReturnValue(null),
      ElectronUpdaterService: class { constructor(readonly updater: unknown) {} },
      get autoUpdater() { throw new Error('real updater touched') },
    }
    expect(() => runInNewContext(`${factory};getUpdaterService()`, context)).toThrow('does not support')
    context.createUpdateSmokeUpdaterFromEnv.mockReturnValue(fake)
    expect(runInNewContext(`${factory};getUpdaterService()`, context).updater).toBe(fake)
  })

  it('pins the real updater to the fork without replacing verification or allowing preview/downgrade', () => {
    const autoUpdater = { setFeedURL: vi.fn(), allowPrerelease: true, allowDowngrade: true }
    const result = runInNewContext(`${factory};getUpdaterService()`, {
      updaterService: null, autoUpdater, LUOYE_UPDATE_FEED, path,
      supportsManualUpdates: () => true, createUpdateSmokeUpdaterFromEnv: () => null,
      process: { env: {}, resourcesPath: 'fixture' },
      ElectronUpdaterService: class { constructor(readonly updater: unknown) {} },
    })
    expect(result.updater).toBe(autoUpdater)
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'zz314657917', repo: 'cc-haha', channel: 'latest', releaseType: 'release' })
    expect(autoUpdater.allowDowngrade).toBe(false)
    expect(autoUpdater.allowPrerelease).toBe(false)
  })
})
