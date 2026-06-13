import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { DataTarget } from '../providers/provider.types'
import { CourseSyncService } from './course-sync.service'

export interface SyncJobResponse {
  jobId: string
  bindingId: string
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
  ) {}

  async createManualSync(
    bindingId: string,
    target: DataTarget,
    input: { username?: string; password?: string; semesterId?: string } = {},
  ): Promise<SyncJobResponse> {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: bindingId },
    })

    if (!binding) {
      throw new NotFoundException('Binding not found')
    }

    if (target !== 'course') {
      throw new BadRequestException('UNSUPPORTED_TARGET: only course sync is implemented')
    }

    if (binding.status === 'unbound' || binding.status === 'disabled') {
      const record = await this.prisma.syncRecord.create({
        data: {
          userId: binding.userId,
          bindingId: binding.id,
          schoolId: binding.schoolId,
          providerId: binding.providerId,
          target,
          status: 'need_login',
          errorCode: 'SESSION_EXPIRED',
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      })

      return {
        jobId: record.id,
        bindingId,
        target,
        status: record.status,
      }
    }

    if (!input.username || !input.password) {
      const record = await this.prisma.syncRecord.create({
        data: {
          userId: binding.userId,
          bindingId: binding.id,
          schoolId: binding.schoolId,
          providerId: binding.providerId,
          target,
          status: 'need_login',
          errorCode: 'SESSION_EXPIRED',
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      })

      return {
        jobId: record.id,
        bindingId,
        target,
        status: record.status,
      }
    }

    const record = await this.prisma.syncRecord.create({
      data: {
        userId: binding.userId,
        bindingId: binding.id,
        schoolId: binding.schoolId,
        providerId: binding.providerId,
        target,
        status: 'running',
        startedAt: new Date(),
      },
    })

    try {
      await this.courseSync.fetchAndCacheByCredentials({
        bindingId,
        username: input.username,
        password: input.password,
        semesterId: input.semesterId,
      })

      await this.prisma.syncRecord.update({
        where: { id: record.id },
        data: {
          status: 'success',
          finishedAt: new Date(),
        },
      })

      return {
        jobId: record.id,
        bindingId,
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
      bindingId: record.bindingId,
      target: record.target,
      status: record.status,
    }
  }
}
