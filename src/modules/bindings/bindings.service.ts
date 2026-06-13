import { Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { BindingSummary } from './bindings.types'

@Injectable()
export class BindingsService {
  constructor(private readonly prisma: PrismaService) {}

  async listBindings(userId?: string): Promise<BindingSummary[]> {
    const bindings = await this.prisma.userSchoolBinding.findMany({
      where: userId ? { userId } : undefined,
      include: {
        school: {
          select: {
            id: true,
            name: true,
            shortName: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    return bindings.map((binding) => this.toSummary(binding))
  }

  async getBinding(bindingId: string): Promise<BindingSummary> {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: bindingId },
      include: {
        school: {
          select: {
            id: true,
            name: true,
            shortName: true,
          },
        },
      },
    })

    if (!binding) {
      throw new NotFoundException('Binding not found')
    }

    return this.toSummary(binding)
  }

  async unbind(bindingId: string) {
    const binding = await this.prisma.userSchoolBinding.findUnique({
      where: { id: bindingId },
    })

    if (!binding) {
      throw new NotFoundException('Binding not found')
    }

    await this.prisma.userSchoolBinding.update({
      where: { id: bindingId },
      data: {
        status: 'unbound',
        sessionReusable: false,
        sessionRefreshable: false,
        sessionExpireAt: null,
      },
    })

    return { success: true }
  }

  private toSummary(binding: {
    id: string
    userId: string
    schoolId: string
    providerId: string
    displayName: string | null
    status: BindingSummary['status']
    sessionReusable: boolean
    sessionRefreshable: boolean
    sessionExpireAt: Date | null
    lastLoginAt: Date | null
    lastCachedAt: Date | null
    school?: {
      id: string
      name: string
      shortName: string | null
    } | null
  }): BindingSummary {
    return {
      id: binding.id,
      userId: binding.userId,
      schoolId: binding.schoolId,
      providerId: binding.providerId,
      displayName: binding.displayName ?? undefined,
      status: binding.status,
      sessionReusable: binding.sessionReusable,
      sessionRefreshable: binding.sessionRefreshable,
      sessionExpireAt: binding.sessionExpireAt?.toISOString(),
      lastLoginAt: binding.lastLoginAt?.toISOString(),
      lastCachedAt: binding.lastCachedAt?.toISOString(),
      school: binding.school
        ? {
            id: binding.school.id,
            name: binding.school.name,
            shortName: binding.school.shortName ?? undefined,
          }
        : undefined,
    }
  }
}
