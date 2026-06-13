import { BadRequestException, Injectable } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { DataTarget, LoginMode } from '../providers/provider.types'

export interface CreateSchoolSubmissionRequest {
  submitterUserId?: string
  schoolName: string
  aliases?: string[]
  province?: string
  city?: string
  officialWebsite?: string
  eduSystemWebsite?: string
  loginUrl?: string
  loginModeHint?: LoginMode
  requestedTargets?: DataTarget[]
  note?: string
}

@Injectable()
export class SubmissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createSubmission(input: CreateSchoolSubmissionRequest) {
    const schoolName = String(input.schoolName || '').trim()

    if (!schoolName) {
      throw new BadRequestException('schoolName is required')
    }

    const submission = await this.prisma.schoolAccessSubmission.create({
      data: {
        submitterUserId: input.submitterUserId,
        schoolName,
        aliases: Array.isArray(input.aliases) ? input.aliases : [],
        province: input.province,
        city: input.city,
        officialWebsite: input.officialWebsite,
        eduSystemWebsite: input.eduSystemWebsite,
        loginUrl: input.loginUrl,
        loginModeHint: input.loginModeHint,
        requestedTargets: Array.isArray(input.requestedTargets) ? input.requestedTargets : ['course'],
        note: input.note,
      },
    })

    return {
      id: submission.id,
      status: submission.status,
      createdAt: submission.createdAt.toISOString(),
    }
  }
}

