import { Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { StudentAccountSummary } from './accounts.types'

@Injectable()
export class StudentAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAccounts(): Promise<StudentAccountSummary[]> {
    const accounts = await this.prisma.studentAccount.findMany({
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
  }): StudentAccountSummary {
    return {
      id: account.id,
      schoolId: account.schoolId,
      providerId: account.providerId,
      displayName: account.displayName ?? undefined,
      status: account.status,
      sessionReusable: account.sessionReusable,
      sessionRefreshable: account.sessionRefreshable,
      sessionExpireAt: account.sessionExpireAt?.toISOString(),
      lastLoginAt: account.lastLoginAt?.toISOString(),
      lastCachedAt: account.lastCachedAt?.toISOString(),
      school: account.school
        ? {
            id: account.school.id,
            name: account.school.name,
            shortName: account.school.shortName ?? undefined,
          }
        : undefined,
    }
  }
}
