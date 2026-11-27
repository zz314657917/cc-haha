import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type AccountVault = {
  read(): string | null
  save(token: string): void
  clear(): void
}

type Encryption = {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** New, separate encrypted binary file. No access token, account metadata or model settings. */
export function createAccountVault(directory: string, storage: Encryption, platform = process.platform): AccountVault {
  return createEncryptedVault(directory, storage, platform, 'luoye-account-refresh-v1.bin', false)
}

export function createModelVault(directory: string, storage: Encryption, platform = process.platform): AccountVault {
  return createEncryptedVault(directory, storage, platform, 'luoye-account-model-v1.bin', true)
}

function createEncryptedVault(directory: string, storage: Encryption, platform: NodeJS.Platform, name: string, required: boolean): AccountVault {
  const file = path.join(directory, name)
  function secure() {
    // The host enables use-mock-keychain on macOS. Never use that key, Linux
    // basic_text, or an unknown backend as durable credential storage.
    return (platform === 'win32' || (platform === 'linux' && ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend()))) && storage.isEncryptionAvailable()
  }
  return {
    read() {
      try { return secure() ? storage.decryptString(readFileSync(file)) : null } catch { return null }
    },
    save(token) {
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        if (!secure()) {
          if (required) throw new Error('Protected model storage unavailable')
          return
        }
        writeFileSync(temp, storage.encryptString(token), { mode: 0o600, flag: 'wx' })
        renameSync(temp, file)
      } catch {
        if (required) throw new Error('Protected model storage unavailable')
        // The active session still works in memory. The old rotated refresh is invalid.
      } finally { rmSync(temp, { force: true }) }
    },
    clear() { rmSync(file, { force: true }) },
  }
}
