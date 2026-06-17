import { Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { ProviderRegistryService } from '../providers/provider-registry.service'
import { CloudCredentialSyncService } from '../sync/cloud-credential-sync.service'
import { StudentAccountSummary } from './accounts.types'

@Injectable()
export class StudentAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistryService,
    private readonly cloudSync: CloudCredentialSyncService,
  ) {}

  async listAccounts(): Promise<StudentAccountSummary[]> {
    const accounts = await this.prisma.studentAccount.findMany({
      include: {
        school: {
          select: {
            id: true,
            name: true,
            shortName: true,
            dataAccess: true,
            capabilities: true,
            config: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    return accounts.map((account) => this.toSummary(account))
  }

  async getAccount(accountId: string): Promise<StudentAccountSummary> {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      include: {
        school: {
          select: {
            id: true,
            name: true,
            shortName: true,
            dataAccess: true,
            capabilities: true,
            config: true,
          },
        },
      },
    })

    if (!account) {
      throw new NotFoundException('Student account not found')
    }

    return this.toSummary(account)
  }

  async deactivateAccount(accountId: string) {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
    })

    if (!account) {
      throw new NotFoundException('Student account not found')
    }

    await this.prisma.studentAccount.update({
      where: { id: accountId },
      data: {
        status: 'unbound',
        sessionReusable: false,
        sessionRefreshable: false,
        sessionExpireAt: null,
      },
    })

    return { success: true }
  }

  private toSummary(account: {
    id: string
    schoolId: string
    providerId: string
    displayName: string | null
    status: StudentAccountSummary['status']
    credentialSaveMode: StudentAccountSummary['credentialSaveMode']
    sessionReusable: boolean
    sessionRefreshable: boolean
    sessionExpireAt: Date | null
    lastLoginAt: Date | null
    lastCachedAt: Date | null
    school?: {
      id: string
      name: string
      shortName: string | null
      dataAccess?: unknown
      capabilities?: unknown
      config?: unknown
    } | null
  }): StudentAccountSummary {
    return {
      id: account.id,
      schoolId: account.schoolId,
      providerId: account.providerId,
      displayName: account.displayName ?? undefined,
      status: account.status,
      credentialSaveMode: account.credentialSaveMode,
      sessionReusable: account.sessionReusable,
      sessionRefreshable: account.sessionRefreshable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      lastLoginAt: account.lastLoginAt?.toISOString(),
      lastCachedAt: account.lastCachedAt?.toISOString(),
      syncStrategy: this.getAccountSyncStrategy(account),
      school: account.school
        ? {
            id: account.school.id,
            name: account.school.name,
            shortName: account.school.shortName ?? undefined,
          }
        : undefined,
    }
  }

  private getAccountSyncStrategy(account: {
    providerId: string
    credentialSaveMode: StudentAccountSummary['credentialSaveMode']
    school?: {
      dataAccess?: unknown
      capabilities?: unknown
      config?: unknown
    } | null
  }): StudentAccountSummary['syncStrategy'] {
    const dataAccess = this.asDataAccess(account.school?.dataAccess)
    const capabilities = this.asCapabilities(account.school?.capabilities)
    const supportsCourse = Boolean(capabilities.course)
    const hasCloudCourse = dataAccess.course.includes('cloud_worker')
    const canUseSavedPassword = this.canUseSavedPasswordSync(account.providerId)
    const canRunCourse = this.cloudSync.canRunTarget(
      account.school?.config,
      'course',
    )

    if (
      supportsCourse &&
      canUseSavedPassword &&
      account.credentialSaveMode === 'password_vault' &&
      hasCloudCourse
    ) {
      return {
        importMode: 'password_server',
        syncMode: 'cloud_worker',
        cloudParserRequired: false,
        localCachePreferred: false,
        scheduledSyncSupported: canRunCourse,
        passwordVaultRequired: false,
        passwordVaultOptional: true,
        manualSyncRequired: !canRunCourse,
        reason: canRunCourse
          ? 'This account can use saved credentials for automatic sync.'
          : 'Cloud sync is configured, but the backend CloudBase environment is not available.',
      }
    }

    return {
      importMode: dataAccess.course.includes('manual_import')
        ? 'manual_import'
        : 'webview_cloud',
      syncMode: 'manual_webview',
      cloudParserRequired: true,
      localCachePreferred: true,
      scheduledSyncSupported: false,
      passwordVaultRequired: false,
      manualSyncRequired: true,
      reason: canRunCourse
        ? 'This account cannot use saved credentials for automatic sync.'
        : 'Cloud sync environment is not configured for this school.',
    }
  }

  private canUseSavedPasswordSync(providerId: string) {
    try {
      return (
        this.providers.getProvider(providerId).meta.credentialSave?.autoSync ===
        'password_login'
      )
    } catch {
      return false
    }
  }

  private asCapabilities(value: unknown) {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Partial<Record<'course' | 'score' | 'exam' | 'profile', unknown>>)
        : {}

    return {
      course: Boolean(source.course),
      score: Boolean(source.score),
      exam: Boolean(source.exam),
      profile: Boolean(source.profile),
    }
  }

  private asDataAccess(value: unknown) {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Partial<Record<'course' | 'score' | 'exam' | 'profile', unknown>>)
        : {}

    return {
      course: Array.isArray(source.course)
        ? source.course.filter((item): item is string => typeof item === 'string')
        : [],
      score: Array.isArray(source.score)
        ? source.score.filter((item): item is string => typeof item === 'string')
        : [],
      exam: Array.isArray(source.exam)
        ? source.exam.filter((item): item is string => typeof item === 'string')
        : [],
      profile: Array.isArray(source.profile)
        ? source.profile.filter((item): item is string => typeof item === 'string')
        : [],
    }
  }
}
