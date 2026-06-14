import { BadRequestException, Injectable } from '@nestjs/common'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

import { EncryptedPayload } from './encrypted-payload.type'

@Injectable()
export class CredentialVaultService {
  encrypt(value: string): EncryptedPayload {
    const key = this.getKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])

    return {
      algorithm: 'aes-256-gcm',
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyVersion: process.env.CREDENTIAL_VAULT_KEY_VERSION || 'v1',
    }
  }

  decrypt(payload: EncryptedPayload): string {
    if (payload.algorithm !== 'aes-256-gcm' || !payload.tag) {
      throw new BadRequestException('Unsupported credential payload')
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.getKey(),
      Buffer.from(payload.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))

    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }

  private getKey() {
    const rawKey = process.env.CREDENTIAL_VAULT_KEY

    if (!rawKey) {
      throw new BadRequestException(
        'CREDENTIAL_VAULT_KEY is required to save credentials',
      )
    }

    return createHash('sha256').update(rawKey).digest()
  }
}
