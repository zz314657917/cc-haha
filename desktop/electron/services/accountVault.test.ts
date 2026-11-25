import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAccountVault } from './accountVault'

describe('LuoyeAI desktop refresh vault', () => {
  it('treats an older installation without an account vault as signed out, persists only protected bytes, and clears it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'luoye-vault-'))
    try {
      const secret = 'fixture-refresh'
      const cipher = Buffer.from('fixture-encrypted')
      const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'unknown', encryptString: vi.fn(() => cipher), decryptString: vi.fn(() => secret) }
      const vault = createAccountVault(dir, storage, 'win32')
      expect(vault.read()).toBeNull()
      vault.save(secret)
      expect(storage.encryptString).toHaveBeenCalledWith(secret)
      expect(readFileSync(path.join(dir, 'luoye-account-refresh-v1.bin'))).toEqual(cipher)
      expect(vault.read()).toBe(secret)
      vault.clear()
      expect(vault.read()).toBeNull()
      expect(readdirSync(dir)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it.each(['linux', 'darwin', 'win32'] as const)('never persists plaintext or uses an unreliable backend on %s', platform => {
    const dir = mkdtempSync(path.join(tmpdir(), 'luoye-vault-'))
    try {
      const storage = { isEncryptionAvailable: () => platform !== 'win32', getSelectedStorageBackend: () => 'basic_text', encryptString: vi.fn(), decryptString: vi.fn() }
      const vault = createAccountVault(dir, storage, platform)
      vault.save('fixture-refresh')
      expect(storage.encryptString).not.toHaveBeenCalled()
      expect(vault.read()).toBeNull()
      expect(readdirSync(dir)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
