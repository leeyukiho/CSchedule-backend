import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { ProviderRegistryService } from '../providers/provider-registry.service'
import { DataTarget } from '../providers/provider.types'
import { CloudCredentialSyncService } from './cloud-credential-sync.service'
import { SyncService } from './sync.service'

const DEFAULT_SCAN_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_BATCH_SIZE = 20

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name])

  return Number.isInteger(value) && value > 0 ? value : fallback
}

function parseTargets(value?: string): DataTarget[] {
  const targets = String(value || 'course')
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is DataTarget =>
      ['course', 'score', 'exam', 'profile'].includes(item),
    )

  return targets.length ? targets : ['course']
}

@Injectable()
export class AutoSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly enabled = process.env.AUTO_SYNC_ENABLED === 'true'
  private readonly scanIntervalMs = getPositiveIntegerEnv(
    'AUTO_SYNC_SCAN_INTERVAL_MS',
    DEFAULT_SCAN_INTERVAL_MS,
  )
  private readonly minIntervalMs = getPositiveIntegerEnv(
    'AUTO_SYNC_MIN_INTERVAL_MS',
    DEFAULT_MIN_INTERVAL_MS,
  )
  private readonly batchSize = getPositiveIntegerEnv(
    'AUTO_SYNC_BATCH_SIZE',
    DEFAULT_BATCH_SIZE,
  )
  private readonly targets = parseTargets(process.env.AUTO_SYNC_TARGETS)

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistryService,
    private readonly cloudSync: CloudCredentialSyncService,
    private readonly syncService: SyncService,
  ) {}

  onModuleInit() {
    if (!this.enabled) {
      return
    }

    this.timer = setInterval(() => {
      void this.scan()
    }, this.scanIntervalMs)
    void this.scan()
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async scan() {
    if (this.running) {
      return
    }

    this.running = true

    try {
      const cutoff = new Date(Date.now() - this.minIntervalMs)
      const accounts = await this.prisma.studentAccount.findMany({
        where: {
          status: { in: ['active', 'cached_only'] },
          credentialSaveMode: 'password_vault',
          school: {
            enabled: true,
            status: 'enabled',
          },
          OR: [{ lastCachedAt: null }, { lastCachedAt: { lt: cutoff } }],
        },
        orderBy: { lastCachedAt: 'asc' },
        take: this.batchSize,
        include: { school: true },
      })

      for (const account of accounts) {
        const targets = this.targets.filter((target) =>
          this.canScheduleProvider(
              account.providerId,
              account.school.dataAccess,
              account.school.config,
              target,
          ),
        )

        if (targets.length > 0) {
          await this.syncService.createManualSync(account.id, { targets })
        }
      }
    } finally {
      this.running = false
    }
  }

  private canScheduleProvider(
    providerId: string,
    dataAccess: unknown,
    config: unknown,
    target: DataTarget,
  ) {
    try {
      const provider = this.providers.getProvider(providerId)

      return (
        provider.meta.credentialSave?.autoSync === 'password_login' &&
        this.asDataAccessTarget(dataAccess, target).includes('cloud_worker') &&
        this.cloudSync.canRunTarget(config, target)
      )
    } catch {
      return false
    }
  }

  private asDataAccessTarget(value: unknown, target: DataTarget) {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    const access = source[target]

    return Array.isArray(access) ? access.filter((item) => typeof item === 'string') : []
  }
}
