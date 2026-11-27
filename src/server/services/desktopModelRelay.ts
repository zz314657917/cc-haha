import { createHmac, timingSafeEqual } from 'node:crypto'

// Read the spawn-time bridge once, before any CLI workers inherit the environment.
// Never resolve these values from settings, provider JSON or an HTTP request.
let port = 0
let token: string | undefined
export function consumeDesktopModelLaunchEnv() {
  const launchPort = Number(process.env.LUOYE_MODEL_RELAY_PORT)
  const launchToken = process.env.LUOYE_MODEL_RELAY_TOKEN
  delete process.env.LUOYE_MODEL_RELAY_PORT
  delete process.env.LUOYE_MODEL_RELAY_TOKEN
  if (Number.isInteger(launchPort) && launchPort > 0 && launchPort <= 65535 && /^[A-Za-z0-9_-]{43}$/.test(launchToken ?? '')) {
    port = launchPort; token = launchToken
  } else { port = 0; token = undefined }
}
export const isDesktopAccountProvider = (id: string) => /^luoye-account-[1-9]\d{0,15}$/.test(id)
let current: { id: string; revision: number } | undefined
export function setDesktopModelSession(userId: string | null, revision: number) {
  current = userId ? { id: `luoye-account-${userId}`, revision } : undefined
}
export function desktopModelTransport(id: string) {
  if (!token || !current || current.id !== id || !isDesktopAccountProvider(id)) return null
  return { baseUrl: `http://127.0.0.1:${port}/${id}`, apiKey: createHmac('sha256', token!).update(`model:${id}:${current.revision}`).digest('base64url') }
}
export function verifyDesktopModelSync(body: string, signature: string | null) {
  if (!token || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false
  return timingSafeEqual(createHmac('sha256', token!).update(body).digest(), Buffer.from(signature, 'hex'))
}
