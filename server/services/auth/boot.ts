// Everything auth needs before it can answer a request: derived keys, the dummy hash (timing
// equalization) and the blocklist. Started at boot; loadAuthKeys() is awaited by server/handlers/02.auth.ts.
import { loadAuthKeys } from './keys'
import { getDummyHash, loadBlocklist } from './password'

export async function ensureAuthReady(): Promise<void> {
  await Promise.all([loadAuthKeys(), getDummyHash(), loadBlocklist()])
}
