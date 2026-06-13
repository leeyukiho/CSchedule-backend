import { BadRequestException, Injectable } from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'

export interface SubmitFeedbackRequest {
  userId?: string
  bindingId?: string
  type?: string
  content: string
  contact?: string
}

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async submitFeedback(input: SubmitFeedbackRequest) {
    const content = String(input.content || '').trim()

    if (!content) {
      throw new BadRequestException('content is required')
    }

    const binding = input.bindingId
      ? await this.prisma.userSchoolBinding.findUnique({
          where: { id: input.bindingId },
        })
      : null

    const feedback = await this.prisma.feedbackItem.create({
      data: {
        userId: input.userId ?? binding?.userId,
        bindingId: input.bindingId,
        schoolId: binding?.schoolId,
        type: String(input.type || 'experience').trim().slice(0, 40),
        content: content.slice(0, 1000),
        contact: input.contact ? String(input.contact).trim().slice(0, 120) : undefined,
      },
    })

    return {
      id: feedback.id,
      status: feedback.status,
      createdAt: feedback.createdAt.toISOString(),
    }
  }
}

