import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { CredentialVaultService } from '../../common/crypto/credential-vault.service'
import { EncryptedPayload } from '../../common/crypto/encrypted-payload.type'
import { PrismaService } from '../../common/prisma/prisma.service'
import { ProviderRegistryService } from '../providers/provider-registry.service'
import { DataTarget, SchoolProvider } from '../providers/provider.types'
import { CloudSyncWorkerService } from './cloud-sync-worker.service'
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
  cacheData?: Record<string, unknown>
}

type SyncStatus = SyncJobResponse['status']

interface ManualSyncAccount {
  id: string
  schoolId: string
  providerId: string
  authState: unknown
  credentialSaveMode: string
}

interface ManualSyncTask {
  key: string
  recordId: string
  account: ManualSyncAccount
  target: DataTarget
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

interface SyncTaskResult {
  cacheData?: Record<string, unknown>
}

const ACTIVE_SYNC_STATUSES: SyncStatus[] = ['pending', 'running']
const DEFAULT_GLOBAL_SYNC_CONCURRENCY = 2
const DEFAULT_SCHOOL_SYNC_CONCURRENCY = 1
const DEFAULT_STALE_SYNC_JOB_MS = 20 * 60 * 1000
const DEFAULT_ACCOUNT_SYNC_COOLDOWN_MS = 5 * 60 * 1000

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
    private readonly credentialVault: CredentialVaultService,
    private readonly providers: ProviderRegistryService,
    private readonly cloudWorker: CloudSyncWorkerService,
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

      return this.toSyncJobResponse(record)
    }

    const support = this.getServerSyncSupport(account.providerId, target)

    if (!support.supported) {
      const now = new Date()
      const record = await this.prisma.syncRecord.create({
        data: {
          accountId: account.id,
          schoolId: account.schoolId,
          providerId: account.providerId,
          target,
          status: 'need_webview_fetch',
          errorCode: 'SERVER_SYNC_UNSUPPORTED',
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
        },
        target,
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

  async getSyncJob(jobId: string): Promise<SyncJobResponse> {
    const record = await this.prisma.syncRecord.findUnique({
      where: { id: jobId },
    })

    if (!record) {
      throw new NotFoundException('Sync job not found')
    }

    return this.toSyncJobResponseWithCache(record)
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

  private async executeManualSyncTask(task: ManualSyncTask): Promise<SyncTaskResult> {
    if (this.cloudWorker.isEnabled()) {
      const cloudResult = await this.cloudWorker.runProviderSync({
        accountId: task.account.id,
        schoolId: task.account.schoolId,
        providerId: task.account.providerId,
        target: task.target,
        username: task.credentials.username,
        password: task.credentials.password,
        semesterId: task.semesterId,
      })

      if (cloudResult.ok) {
        const cacheData = this.getCloudWorkerCacheData(cloudResult.result)

        if (!cacheData) {
          throw new Error('CLOUD_WORKER_EMPTY_RESULT')
        }

        await this.courseSync.writeCloudCacheResult({
          accountId: task.account.id,
          target: task.target,
          cacheData,
        })
        return { cacheData }
      }

      if (!cloudResult.unsupported) {
        throw new Error(
          cloudResult.errorMessage ||
            cloudResult.errorCode ||
            'CLOUD_WORKER_SYNC_FAILED',
        )
      }
    }

    if (task.target === 'course') {
      await this.courseSync.fetchAndCacheByCredentials({
        accountId: task.account.id,
        username: task.credentials.username,
        password: task.credentials.password,
        semesterId: task.semesterId,
        allSemesters: false,
        credentialSaveMode:
          task.account.credentialSaveMode === 'password_vault'
            ? 'password_vault'
            : 'none',
        authStatePatch: this.getCredentialAuthStatePatch(task.account.authState),
      })
      return {}
    }

    await this.courseSync.fetchAndCacheFeatureByCredentials({
      accountId: task.account.id,
      target: task.target as Exclude<DataTarget, 'course'>,
      username: task.credentials.username,
      password: task.credentials.password,
      semesterId: task.semesterId,
    })
    return {}
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

  private async getLatestCacheData(accountId: string, target: DataTarget) {
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
      },
    })

    if (!account) {
      return null
    }

    const session = {
      sessionReusable: account.sessionReusable,
      sessionRefreshable: account.sessionRefreshable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      accountStatus: account.status,
    }

    if (target === 'course') {
      const cache = await this.prisma.courseCache.findFirst({
        where: { accountId },
        orderBy: { syncedAt: 'desc' },
      })

      if (!cache) {
        return null
      }

      return {
        accountId,
        schoolId: account.schoolId,
        providerId: account.providerId,
        termId: cache.termId ?? undefined,
        courses: this.asArray(cache.coursesJson),
        terms: this.asArray(cache.termsJson),
        sectionTimes: this.asArray(cache.sectionTimesJson),
        sourceHash: cache.sourceHash,
        syncedAt: cache.syncedAt.toISOString(),
        session,
      }
    }

    const cache = await this.prisma.featureCache.findFirst({
      where: { accountId, target },
      orderBy: { syncedAt: 'desc' },
    })

    if (!cache) {
      return null
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

  private async toSyncJobResponseWithCache(record: SyncRecordSnapshot): Promise<SyncJobResponse> {
    const response = this.toSyncJobResponse(record)

    if (record.status !== 'success') {
      return response
    }

    const cacheData = await this.getLatestCacheData(record.accountId, record.target)

    return cacheData ? { ...response, cacheData } : response
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

  private getServerSyncSupport(providerId: string, target: DataTarget) {
    try {
      const provider = this.providers.getProvider(providerId)
      const accessModes = provider.meta.dataAccess?.[target] ?? []

      if (!accessModes.includes('server_session')) {
        return {
          supported: false,
          reason: 'This data target is configured for frontend import only',
        }
      }

      if (
        !provider.meta.credentialSave ||
        provider.meta.credentialSave.autoSync !== 'password_login'
      ) {
        return {
          supported: false,
          reason: 'This provider is not approved for stable password auto-sync',
        }
      }

      if (!this.cloudWorker.isEnabled() && !this.hasServerConnector(provider, target)) {
        return {
          supported: false,
          reason: 'This provider has no backend connector for this data target',
        }
      }

      return { supported: true, reason: '' }
    } catch {
      if (this.cloudWorker.isEnabled()) {
        return { supported: true, reason: '' }
      }

      return {
        supported: false,
        reason: 'Provider is not registered for backend auto-sync',
      }
    }
  }

  private hasServerConnector(
    provider: SchoolProvider,
    target: DataTarget,
  ) {
    if (target === 'course') {
      return Boolean(provider.course)
    }

    if (target === 'score') {
      return Boolean(provider.score)
    }

    if (target === 'exam') {
      return Boolean(provider.exam)
    }

    if (target === 'profile') {
      return Boolean(provider.profile)
    }

    return false
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

  private asArray(value: unknown) {
    return Array.isArray(value) ? value : []
  }

  private getCloudWorkerCacheData(value: unknown) {
    const record = this.asRecord(value)
    const cacheData = this.asRecord(record.cacheData)

    if (Object.keys(cacheData).length > 0) {
      return cacheData
    }

    return Object.keys(record).length > 0 ? record : null
  }
}
