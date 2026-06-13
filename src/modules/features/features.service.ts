import { Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { DataTarget } from '../providers/provider.types'

@Injectable()
export class FeaturesService {
  constructor(private readonly prisma: PrismaService) {}

  async getFeature(bindingId: string, target: Exclude<DataTarget, 'course'>, termId?: string) {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: bindingId },
    })

    if (!binding) {
      throw new NotFoundException('Binding not found')
    }

    const cache = await this.prisma.featureCache.findFirst({
      where: {
        bindingId,
        target,
        ...(termId ? { termId } : {}),
      },
      orderBy: { syncedAt: 'desc' },
    })

    return {
      bindingId,
      schoolId: binding.schoolId,
      providerId: binding.providerId,
      target,
      termId: cache?.termId ?? termId,
      data: cache?.dataJson ?? null,
      meta: cache?.metaJson ?? null,
      syncedAt: cache?.syncedAt.toISOString(),
      session: {
        sessionReusable: binding.sessionReusable,
        sessionRefreshable: binding.sessionRefreshable,
        sessionExpireAt: binding.sessionExpireAt?.toISOString(),
        bindingStatus: binding.status,
      },
    }
  }
}

