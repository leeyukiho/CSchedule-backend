import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { CredentialVaultService } from '../../common/crypto/credential-vault.service'
import { EncryptedPayload } from '../../common/crypto/encrypted-payload.type'
import { PrismaService } from '../../common/prisma/prisma.service'
import { DataTarget } from '../providers/provider.types'
import { CourseSyncService } from './course-sync.service'

export interface SyncJobResponse {
  jobId: string
  accountId: string
  target: DataTarget
  status:
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'need_login'
    | 'need_webview_fetch'
    | 'cancelled'
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseSync: CourseSyncService,
    private readonly credentialVault: CredentialVaultService,
  ) {}

  async createManualSync(
    accountId: string,
    target: DataTarget,
    input: { username?: string; password?: string; semesterId?: string } = {},
  ): Promise<SyncJobResponse> {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
    })

    if (!account) {
      throw new NotFoundException('Student account not found')
    }

    if (!['course', 'score', 'profile'].includes(target)) {
      throw new BadRequestException(
        'UNSUPPORTED_TARGET: only course, score and profile sync are implemented',
      )
    }

    if (account.status === 'unbound' || account.status === 'disabled') {
      const record = await this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target,
          status: 'need_login',
          errorCode: 'SESSION_EXPIRED',
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      })

      return {
        jobId: record.id,
        accountId,
        target,
        status: record.status,
      }
    }

    const credentials = this.resolveCredentials(account.authState, input)

    if (!credentials.username || !credentials.password) {
      const record = await this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target,
          status: 'need_login',
          errorCode: 'SESSION_EXPIRED',
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      })

      return {
        jobId: record.id,
        accountId,
        target,
        status: record.status,
      }
    }

    const record = await this.prisma.syncRecord.create({
      data: {
        accountId: account.id,
        schoolId: account.schoolId,
        providerId: account.providerId,
        target,
        status: 'running',
        startedAt: new Date(),
      },
    })

    try {
      if (target === 'course') {
        await this.courseSync.fetchAndCacheByCredentials({
          accountId,
          username: credentials.username,
          password: credentials.password,
          semesterId: input.semesterId,
          allSemesters: true,
          credentialSaveMode:
            account.credentialSaveMode === 'password_vault'
              ? 'password_vault'
              : 'none',
          authStatePatch: this.getCredentialAuthStatePatch(account.authState),
        })
      } else {
        await this.courseSync.fetchAndCacheFeatureByCredentials({
          accountId,
          target,
          username: credentials.username,
          password: credentials.password,
          semesterId: input.semesterId,
        })
      }

      await this.prisma.syncRecord.update({
        where: { id: record.id },
        data: {
          status: 'success',
          finishedAt: new Date(),
        },
      })

      return {
        jobId: record.id,
        accountId,
        target,
        status: 'success',
      }
    } catch (error) {
      await this.prisma.syncRecord.update({
        where: { id: record.id },
        data: {
          status: 'failed',
          errorCode: 'UNKNOWN',
          errorMessage: error instanceof Error ? error.message : 'Sync failed',
          finishedAt: new Date(),
        },
      })

      throw error
    }
  }

  async getSyncJob(jobId: string): Promise<SyncJobResponse> {
    const record = await this.prisma.syncRecord.findUnique({
      where: { id: jobId },
    })

    if (!record) {
      throw new NotFoundException('Sync job not found')
    }

    return {
      jobId: record.id,
      accountId: record.accountId,
      target: record.target,
      status: record.status,
    }
  }

  private resolveCredentials(
    authState: unknown,
    input: { username?: string; password?: string },
  ) {
    if (input.username && input.password) {
      return {
        username: input.username,
        password: input.password,
      }
    }

    const vault = this.asRecord(this.asRecord(authState).credentialVault)
    const usernamePayload = this.asEncryptedPayload(vault.username)
    const passwordPayload = this.asEncryptedPayload(vault.password)

    if (!usernamePayload || !passwordPayload) {
      return { username: '', password: '' }
    }

    return {
      username: this.credentialVault.decrypt(usernamePayload),
      password: this.credentialVault.decrypt(passwordPayload),
    }
  }

  private getCredentialAuthStatePatch(authState: unknown) {
    const vault = this.asRecord(this.asRecord(authState).credentialVault)

    return Object.keys(vault).length > 0 ? { credentialVault: vault } : undefined
  }

  private asEncryptedPayload(value: unknown): EncryptedPayload | null {
    const payload = this.asRecord(value)

    if (
      typeof payload.algorithm === 'string' &&
      typeof payload.ciphertext === 'string' &&
      typeof payload.iv === 'string'
    ) {
      return payload as unknown as EncryptedPayload
    }

    return null
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
}
