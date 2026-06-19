import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { CredentialVaultService } from '../../common/crypto/credential-vault.service'
import { EncryptedPayload } from '../../common/crypto/encrypted-payload.type'
import { PrismaService } from '../../common/prisma/prisma.service'
import { ProviderDisplayService } from '../providers/provider-display.service'
import { ProviderRegistryService } from '../providers/provider-registry.service'
import { DataTarget } from '../providers/provider.types'
import { CloudCredentialSyncService } from './cloud-credential-sync.service'
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
    | 'rate_limited'
    | 'cancelled'
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  queuePosition?: number
  runningAhead?: number
  errorCode?: string
  errorMessage?: string
  cacheResults?: Array<{
    target: DataTarget
    cacheData: Record<string, unknown>
  }>
}

type SyncStatus = SyncJobResponse['status']

interface ManualSyncAccount {
  id: string
  schoolId: string
  providerId: string
  authState: unknown
  credentialSaveMode: string
  schoolConfig: unknown
}

interface ManualSyncTask {
  key: string
  recordId: string
  account: ManualSyncAccount
  target: DataTarget
  targets: DataTarget[]
  credentials: {
    username: string
    password: string
  }
  semesterId?: string
}

interface SyncRecordSnapshot {
  id: string
  accountId: string
  target: DataTarget
  status: SyncStatus
  errorCode: string | null
  errorMessage: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

const ACTIVE_SYNC_STATUSES: SyncStatus[] = ['pending', 'running']
const DEFAULT_GLOBAL_SYNC_CONCURRENCY = 2
const DEFAULT_SCHOOL_SYNC_CONCURRENCY = 1
const DEFAULT_STALE_SYNC_JOB_MS = 20 * 60 * 1000
const DEFAULT_ACCOUNT_SYNC_COOLDOWN_MS = 10 * 60 * 1000

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name])

  return Number.isInteger(value) && value > 0 ? value : fallback
}

@Injectable()
export class SyncService {
  private readonly globalSyncConcurrency = getPositiveIntegerEnv(
    'SYNC_GLOBAL_CONCURRENCY',
    DEFAULT_GLOBAL_SYNC_CONCURRENCY,
  )
  private readonly schoolSyncConcurrency = getPositiveIntegerEnv(
    'SYNC_SCHOOL_CONCURRENCY',
    DEFAULT_SCHOOL_SYNC_CONCURRENCY,
  )
  private readonly staleSyncJobMs = getPositiveIntegerEnv(
    'SYNC_STALE_JOB_MS',
    DEFAULT_STALE_SYNC_JOB_MS,
  )
  private readonly accountSyncCooldownMs = getPositiveIntegerEnv(
    'SYNC_ACCOUNT_COOLDOWN_MS',
    DEFAULT_ACCOUNT_SYNC_COOLDOWN_MS,
  )
  private readonly pendingSyncTasks: ManualSyncTask[] = []
  private readonly activeSyncKeys = new Set<string>()
  private readonly runningSyncBySchool = new Map<string, number>()
  private runningSyncCount = 0

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseSync: CourseSyncService,
    private readonly cloudSync: CloudCredentialSyncService,
    private readonly credentialVault: CredentialVaultService,
    private readonly providers: ProviderRegistryService,
    private readonly providerDisplay: ProviderDisplayService,
  ) {}

  async createManualSync(
    accountId: string,
    input: { username?: string; password?: string; semesterId?: string; targets?: DataTarget[] } = {},
  ): Promise<SyncJobResponse> {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      include: { school: true },
    })

    if (!account) {
      throw new NotFoundException('Student account not found')
    }

    const targets = this.normalizeTargets(input.targets)
    const target = targets[0]

    if (!target || targets.length === 0) {
      throw new BadRequestException(
        'UNSUPPORTED_TARGETS: targets must include course, score, exam or profile',
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

      return this.toSyncJobResponse(record)
    }

    const support = this.getCloudSyncSupport({
      providerId: account.providerId,
      schoolConfig: account.school.config,
      dataAccess: account.school.dataAccess,
      targets,
    })

    if (!support.supported) {
      const now = new Date()
      const record = await this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target,
          status: 'need_webview_fetch',
          errorCode: 'CLOUD_SYNC_UNSUPPORTED',
          errorMessage: support.reason,
          startedAt: now,
          finishedAt: now,
        },
      })

      return this.toSyncJobResponse(record)
    }

    if (account.credentialSaveMode !== 'password_vault') {
      const now = new Date()
      const record = await this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target,
          status: 'need_webview_fetch',
          errorCode: 'SAVED_CREDENTIAL_REQUIRED',
          errorMessage: 'Backend sync requires encrypted saved credentials',
          startedAt: now,
          finishedAt: now,
        },
      })

      return this.toSyncJobResponse(record)
    }

    const key = this.getSyncKey(account.id, target)
    await this.expireStaleSyncJobs(account.id, target)

    const activeJob = await this.findActiveSyncJob(account.id, target)

    if (activeJob) {
      return activeJob
    }

    const cooldown = await this.findCooldownSyncJob(account.id, target)

    if (cooldown) {
      const now = new Date()
      const record = await this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target,
          status: 'rate_limited',
          errorCode: 'RATE_LIMITED',
          errorMessage: 'Please wait before syncing this target again',
          startedAt: now,
          finishedAt: now,
        },
      })

      return this.toSyncJobResponse(record)
    }

    const credentials = this.resolveCredentials(account.authState, {})

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

      return this.toSyncJobResponse(record)
    }

    try {
      const record = await this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target,
          status: 'pending',
        },
      })

      this.activeSyncKeys.add(key)
      this.enqueueManualSync({
        key,
        recordId: record.id,
        account: {
          id: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          authState: account.authState,
          credentialSaveMode: account.credentialSaveMode,
          schoolConfig: account.school.config,
        },
        target,
        targets,
        credentials,
        semesterId: input.semesterId,
      })

      return this.toSyncJobResponse(record)
    } catch (error) {
      this.activeSyncKeys.delete(key)

      if (this.isUniqueConstraintError(error)) {
        const existingJob = await this.findActiveSyncJob(account.id, target)

        if (existingJob) {
          this.activeSyncKeys.add(key)
          return existingJob
        }
      }

      throw error
    }
  }

  async getSyncJob(jobId: string, includeCache = false): Promise<SyncJobResponse> {
    const record = await this.prisma.syncRecord.findUnique({
      where: { id: jobId },
    })

    if (!record) {
      throw new NotFoundException('Sync job not found')
    }

    return includeCache ? this.toSyncJobResponseWithCache(record) : this.toSyncJobResponse(record)
  }

  private enqueueManualSync(task: ManualSyncTask) {
    this.pendingSyncTasks.push(task)
    this.drainSyncQueue()
  }

  private drainSyncQueue() {
    while (this.runningSyncCount < this.globalSyncConcurrency) {
      const taskIndex = this.pendingSyncTasks.findIndex((task) =>
        this.canStartSyncTask(task),
      )

      if (taskIndex < 0) {
        return
      }

      const [task] = this.pendingSyncTasks.splice(taskIndex, 1)

      if (!task) {
        return
      }

      this.runningSyncCount += 1
      this.runningSyncBySchool.set(
        task.account.schoolId,
        (this.runningSyncBySchool.get(task.account.schoolId) ?? 0) + 1,
      )

      void this.runManualSyncTask(task).finally(() => {
        this.runningSyncCount -= 1
        this.activeSyncKeys.delete(task.key)
        this.runningSyncBySchool.set(
          task.account.schoolId,
          Math.max((this.runningSyncBySchool.get(task.account.schoolId) ?? 1) - 1, 0),
        )
        this.drainSyncQueue()
      })
    }
  }

  private canStartSyncTask(task: ManualSyncTask) {
    return (
      this.runningSyncCount < this.globalSyncConcurrency &&
      (this.runningSyncBySchool.get(task.account.schoolId) ?? 0) <
        this.schoolSyncConcurrency
    )
  }

  private async runManualSyncTask(task: ManualSyncTask) {
    const startedAt = new Date()
    const running = await this.prisma.syncRecord.updateMany({
      where: { id: task.recordId, status: 'pending' },
      data: {
        status: 'running',
        startedAt,
        errorCode: null,
        errorMessage: null,
      },
    })

    if (running.count === 0) {
      return
    }

    try {
      const result = await this.executeManualSyncTask(task)
      await this.prisma.syncRecord.update({
        where: { id: task.recordId },
        data: {
          status: 'success',
          finishedAt: new Date(),
        },
      })
    } catch (error) {
      const failure = this.normalizeSyncError(error)

      await this.prisma.syncRecord.update({
        where: { id: task.recordId },
        data: {
          status: failure.status,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
          finishedAt: new Date(),
        },
      })
    }
  }

  private async executeManualSyncTask(task: ManualSyncTask): Promise<void> {
    const result = await this.cloudSync.syncByCredentials({
      schoolId: task.account.schoolId,
      providerId: task.account.providerId,
      targets: task.targets,
      username: task.credentials.username,
      password: task.credentials.password,
      semesterId: task.semesterId,
      config: task.account.schoolConfig,
    })
    const authStatePatch = this.getCredentialAuthStatePatch(task.account.authState)

    for (const cacheResult of result.cacheResults) {
      await this.courseSync.writeCloudCacheResult({
        accountId: task.account.id,
        target: cacheResult.target,
        cacheData: cacheResult.cacheData,
        credentialSaveMode:
          task.account.credentialSaveMode === 'password_vault'
            ? 'password_vault'
            : 'none',
        authStatePatch,
      })
    }

  }

  private async expireStaleSyncJobs(accountId: string, target: DataTarget) {
    const cutoff = new Date(Date.now() - this.staleSyncJobMs)

    await this.prisma.syncRecord.updateMany({
      where: {
        accountId,
        target,
        status: { in: ACTIVE_SYNC_STATUSES },
        OR: [
          { startedAt: { lt: cutoff } },
          { startedAt: null, createdAt: { lt: cutoff } },
        ],
      },
      data: {
        status: 'failed',
        errorCode: 'SYNC_JOB_STALE',
        errorMessage: 'Sync job expired before completion',
        finishedAt: new Date(),
      },
    })
  }

  private async findActiveSyncJob(accountId: string, target: DataTarget) {
    const record = await this.prisma.syncRecord.findFirst({
      where: {
        accountId,
        target,
        status: { in: ACTIVE_SYNC_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    })

    return record ? this.toSyncJobResponse(record) : null
  }

  private getLatestCacheData(
    account: {
      id: string
      schoolId: string
      providerId: string
      status: SyncStatus | string
      sessionReusable: boolean
      sessionRefreshable: boolean
      sessionExpireAt: Date | null
      school: { config: Prisma.JsonValue }
    },
    target: DataTarget,
    cache?: {
      termId: string | null
      coursesJson?: unknown
      termsJson?: unknown
      sectionTimesJson?: unknown
      dataJson?: unknown
      metaJson?: unknown
      sourceHash: string
      syncedAt: Date
    } | null,
  ) {
    if (!cache) {
      return null
    }

    const accountId = account.id
    const session = {
      sessionReusable: account.sessionReusable,
      sessionRefreshable: account.sessionRefreshable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      accountStatus: account.status,
    }

    if (target === 'course') {
      const cacheSectionTimes = this.asArray(cache.sectionTimesJson)
      const configuredSectionTimes = this.providerDisplay.getSectionTimes(
        account.school.config,
        account.providerId,
      )

      return {
        accountId,
        schoolId: account.schoolId,
        providerId: account.providerId,
        termId: cache.termId ?? undefined,
        courses: this.asArray(cache.coursesJson),
        terms: this.asArray(cache.termsJson),
        sectionTimes: cacheSectionTimes.length ? cacheSectionTimes : configuredSectionTimes,
        sourceHash: cache.sourceHash,
        syncedAt: cache.syncedAt.toISOString(),
        session,
      }
    }

    return {
      accountId,
      schoolId: account.schoolId,
      providerId: account.providerId,
      target,
      termId: cache.termId ?? undefined,
      data: cache.dataJson,
      meta: cache.metaJson,
      sourceHash: cache.sourceHash,
      syncedAt: cache.syncedAt.toISOString(),
      session,
    }
  }

  private async getLatestCacheResults(accountId: string): Promise<NonNullable<SyncJobResponse['cacheResults']>> {
    const account = await this.prisma.studentAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        schoolId: true,
        providerId: true,
        status: true,
        sessionReusable: true,
        sessionRefreshable: true,
        sessionExpireAt: true,
        school: {
          select: {
            config: true,
          },
        },
      },
    })

    if (!account) {
      return []
    }

    const [courseCache, featureCaches] = await Promise.all([
      this.prisma.courseCache.findFirst({
        where: { accountId },
        orderBy: { syncedAt: 'desc' },
      }),
      this.prisma.featureCache.findMany({
        where: { accountId, target: { in: ['profile', 'score', 'exam'] } },
        orderBy: [{ target: 'asc' }, { syncedAt: 'desc' }],
      }),
    ])
    const latestFeatureCacheByTarget = new Map<DataTarget, (typeof featureCaches)[number]>()

    for (const cache of featureCaches) {
      if (!latestFeatureCacheByTarget.has(cache.target)) {
        latestFeatureCacheByTarget.set(cache.target, cache)
      }
    }

    const cacheResults = [
      {
        target: 'course' as DataTarget,
        cacheData: this.getLatestCacheData(account, 'course', courseCache),
      },
      ...(['profile', 'score', 'exam'] as DataTarget[]).map((target) => ({
        target,
        cacheData: this.getLatestCacheData(account, target, latestFeatureCacheByTarget.get(target)),
      })),
    ]
    const results: NonNullable<SyncJobResponse['cacheResults']> = []

    for (const result of cacheResults) {
      if (result.cacheData) {
        results.push({
          target: result.target,
          cacheData: result.cacheData as Record<string, unknown>,
        })
      }
    }

    return results
  }

  private async toSyncJobResponseWithCache(record: SyncRecordSnapshot): Promise<SyncJobResponse> {
    const response = this.toSyncJobResponse(record)

    if (record.status !== 'success') {
      return response
    }

    const cacheResults = await this.getLatestCacheResults(record.accountId)

    return {
      ...response,
      ...(cacheResults.length ? { cacheResults } : {}),
    }
  }

  private toSyncJobResponse(record: SyncRecordSnapshot): SyncJobResponse {
    const pendingIndex = this.pendingSyncTasks.findIndex(
      (task) => task.recordId === record.id,
    )
    const queuePosition = pendingIndex >= 0 ? pendingIndex + 1 : undefined
    const runningAhead =
      record.status === 'pending' && pendingIndex >= 0
        ? this.runningSyncCount + pendingIndex
        : record.status === 'running'
          ? Math.max(this.runningSyncCount - 1, 0)
          : undefined

    return {
      jobId: record.id,
      accountId: record.accountId,
      target: record.target,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      startedAt: record.startedAt?.toISOString(),
      finishedAt: record.finishedAt?.toISOString(),
      queuePosition,
      runningAhead,
      errorCode: record.errorCode ?? undefined,
      errorMessage: record.errorMessage ?? undefined,
    }
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
  }

  private getSyncKey(accountId: string, target: DataTarget) {
    return `${accountId}:${target}`
  }

  private getCloudSyncSupport(input: {
    providerId: string
    schoolConfig: unknown
    dataAccess: unknown
    targets: DataTarget[]
  }) {
    try {
      const provider = this.providers.getProvider(input.providerId)

      if (
        !provider.meta.credentialSave ||
        provider.meta.credentialSave.autoSync !== 'password_login'
      ) {
        return {
          supported: false,
          reason: 'This provider is not approved for stable password auto-sync',
        }
      }

      for (const target of input.targets) {
        const accessModes = this.asDataAccessTarget(input.dataAccess, target)

        if (!accessModes.includes('cloud_worker')) {
          return {
            supported: false,
            reason: `Data target ${target} is not configured for cloud worker sync`,
          }
        }
      }

      const cloudFunction = this.cloudSync.getSharedCloudFunction(
        input.schoolConfig,
        input.targets,
      )

      if (!cloudFunction) {
        return {
          supported: false,
          reason: 'Requested data targets have no shared cloud sync function',
        }
      }

      if (!this.canRunCloudFunction(cloudFunction)) {
        return {
          supported: false,
          reason: 'Cloud sync environment is not configured for requested data targets',
        }
      }

      return { supported: true, reason: '' }
    } catch {
      return {
        supported: false,
        reason: 'Provider is not registered for cloud auto-sync',
      }
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

  private async findCooldownSyncJob(accountId: string, target: DataTarget) {
    if (this.accountSyncCooldownMs <= 0) {
      return null
    }

    const cutoff = new Date(Date.now() - this.accountSyncCooldownMs)

    return this.prisma.syncRecord.findFirst({
      where: {
        accountId,
        target,
        status: 'success',
        finishedAt: { gt: cutoff },
      },
      orderBy: { finishedAt: 'desc' },
    })
  }

  private normalizeSyncError(error: unknown): {
    status: SyncStatus
    errorCode: string
    errorMessage: string
  } {
    const message = error instanceof Error ? error.message : 'Sync failed'
    const lowerMessage = message.toLowerCase()

    if (
      message.includes('WTBU_INVALID_CREDENTIALS') ||
      lowerMessage.includes('invalid credential') ||
      message.includes('密码错误') ||
      message.includes('用户名或密码') ||
      message.includes('账号或密码')
    ) {
      return {
        status: 'need_login',
        errorCode: 'INVALID_CREDENTIAL',
        errorMessage: message,
      }
    }

    if (message.includes('CLOUD_SYNC_NOT_CONFIGURED')) {
      return {
        status: 'need_webview_fetch',
        errorCode: 'CLOUD_SYNC_NOT_CONFIGURED',
        errorMessage: message,
      }
    }

    if (message.includes('CLOUD_SYNC_EMPTY_RESULT')) {
      return {
        status: 'failed',
        errorCode: 'CLOUD_SYNC_EMPTY_RESULT',
        errorMessage: message,
      }
    }

    if (
      message.includes('SIGN_PARAM_INVALID') ||
      lowerMessage.includes('tmp secret key expire') ||
      lowerMessage.includes('temporary key') ||
      lowerMessage.includes('session token')
    ) {
      return {
        status: 'need_webview_fetch',
        errorCode: 'CLOUD_SYNC_CREDENTIAL_EXPIRED',
        errorMessage:
          'CloudBase credential expired. Remove the expired TENCENTCLOUD_SESSIONTOKEN or refresh Tencent Cloud temporary credentials.',
      }
    }

    if (
      lowerMessage.includes('captcha') ||
      message.includes('验证码') ||
      message.includes('扫码')
    ) {
      return {
        status: 'need_webview_fetch',
        errorCode: 'NEED_WEBVIEW_FETCH',
        errorMessage: message,
      }
    }

    if (
      lowerMessage.includes('rate limit') ||
      lowerMessage.includes('too many requests') ||
      message.includes('频繁')
    ) {
      return {
        status: 'rate_limited',
        errorCode: 'SCHOOL_RATE_LIMITED',
        errorMessage: message,
      }
    }

    if (lowerMessage.includes('parser')) {
      return {
        status: 'failed',
        errorCode: 'PARSER_FAILED',
        errorMessage: message,
      }
    }

    return {
      status: 'failed',
      errorCode: 'UNKNOWN',
      errorMessage: message,
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

  private asDataAccessTarget(value: unknown, target: DataTarget) {
    const source = this.asRecord(value)
    const access = source[target]

    return Array.isArray(access) ? access.filter((item) => typeof item === 'string') : []
  }

  private asArray(value: unknown) {
    return Array.isArray(value) ? value : []
  }

  private normalizeTargets(targets: DataTarget[] | undefined) {
    if (targets === undefined) {
      return ['course'] as DataTarget[]
    }

    const normalized = Array.isArray(targets)
      ? targets.filter((target): target is DataTarget =>
          ['course', 'score', 'exam', 'profile'].includes(target),
        )
      : []

    return [...new Set(normalized)]
  }

  private canRunCloudFunction(cloudFunction: { functionName?: string; url?: string }) {
    return Boolean(
      cloudFunction.url ||
        (cloudFunction.functionName &&
          (process.env.CLOUDBASE_ENV_ID ||
            process.env.TCB_ENV_ID ||
            process.env.TARO_APP_CLOUDBASE_ENV_ID)),
    )
  }

}
