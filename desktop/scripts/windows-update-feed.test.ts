// @vitest-environment node

import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

it('keeps the Windows install identity and uses only the fork’s stable GitHub feed', () => {
  expect(manifest.build.appId).toBe('com.luoyeai.desktop')
  expect(manifest.build.win.target).toBe('nsis')
  expect(manifest.build.win.publish).toEqual({
    provider: 'github', owner: 'zz314657917', repo: 'cc-haha', channel: 'latest', releaseType: 'release',
  })
})
