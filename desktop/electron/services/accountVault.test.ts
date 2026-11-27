import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAccountVault, createModelVault } from './accountVault'

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
  it('persists account-bound model secrets only in a separate protected file and fails closed without encryption', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'luoye-model-vault-'))
    try {
      const record = JSON.stringify({ userId: '42', key: 'fixture-model-only' })
      const cipher = Buffer.from('opaque-protected-test-bytes')
      const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'unknown', encryptString: vi.fn(() => cipher), decryptString: vi.fn(() => record) }
      const vault = createModelVault(dir, storage, 'win32'); vault.save(record)
      expect(readdirSync(dir)).toEqual(['luoye-account-model-v1.bin'])
      expect(readFileSync(path.join(dir, 'luoye-account-model-v1.bin'))).toEqual(cipher)
      expect(vault.read()).toBe(record)
      vault.clear(); storage.isEncryptionAvailable = () => false
      expect(() => vault.save(record)).toThrow(); expect(readdirSync(dir)).toEqual([])
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
