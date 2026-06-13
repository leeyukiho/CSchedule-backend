export interface EncryptedPayload {
  algorithm: string
  ciphertext: string
  iv: string
  tag?: string
  keyVersion?: string
}
