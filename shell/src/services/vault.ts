import { nativeCall } from '../native/bridge'
import { readCredential, saveCredential, type EncryptedCredential } from './storage'

export interface CredentialPayload { apiKey?: string; password?: string; inlineProxyPassword?: string }
export function encryptCredentialRecord(id: string, value: CredentialPayload): Promise<EncryptedCredential> { return nativeCall('credential_protect', { id, value }) }
export async function saveCredentialRecord(id: string, value: CredentialPayload): Promise<void> { await saveCredential(await encryptCredentialRecord(id, value)) }
export async function loadCredentialRecord(id: string): Promise<CredentialPayload | undefined> {
  const record = await readCredential(id)
  return record ? nativeCall('credential_unprotect', { record }) : undefined
}
