import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountErrorCode, AccountResult, AccountStatus, DesktopHost } from '@/lib/desktopHost'
import type { TranslationKey } from '@/i18n'

export function accountErrorKey(code: AccountErrorCode): TranslationKey {
  if (code === 'network') return 'rail.offline'
  if (code === 'unauthorized') return 'rail.expired'
  if (code === 'timeout') return 'rail.timeout'
  return 'rail.serviceUnavailable'
}

/** No credential, identity or notice is persisted by the renderer. */
export function useRailAccount(api: DesktopHost['account'] | undefined) {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [error, setError] = useState<TranslationKey | null>(null)
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const version = useRef(0)
  const operation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++version.current
    if (!api) { setStatus({ status: 'unavailable', authenticated: false }); return }
    try {
      let result: AccountResult<AccountStatus> = await api.getStatus()
      if (current !== version.current) return
      if (result.ok && result.data.authenticated && !result.data.profile) {
        const profile = await api.getProfile()
        result = profile.ok ? { ok: true, data: { ...result.data, profile: profile.data } } : profile
      }
      if (current !== version.current) return
      if (result.ok) {
        setStatus(result.data)
        setError(null)
      } else {
        setStatus({ status: result.error.code === 'unauthorized' ? 'signed-out' : 'unavailable', authenticated: false })
        setError(accountErrorKey(result.error.code))
      }
    } catch {
      if (current !== version.current) return
      setError('rail.serviceUnavailable')
      setStatus({ status: 'unavailable', authenticated: false })
    }
  }, [api])

  useEffect(() => {
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { version.current++; operation.current++; window.removeEventListener('focus', refresh) }
  }, [refresh])

  const act = async (action: 'beginLogin' | 'cancelLogin' | 'signOut') => {
    if (!api) return
    const current = ++operation.current
    version.current++
    setError(null)
    setBusy(action === 'signOut' ? 'logout' : 'login')
    try {
      const result = await api[action]()
      if (current !== operation.current) return
      await refresh()
      if (current !== operation.current) return
      if (!result.ok && result.error.code !== 'cancelled') setError(accountErrorKey(result.error.code))
    } catch {
      if (current === operation.current) setError('rail.serviceUnavailable')
    } finally {
      if (current === operation.current) setBusy(null)
    }
  }

  const expire = useCallback(() => {
    version.current++
    setStatus({ status: 'signed-out', authenticated: false })
    setError('rail.expired')
  }, [])
  return { status, error, busy, refresh, act, expire }
}
