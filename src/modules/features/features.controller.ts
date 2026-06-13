import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'

import { FeaturesService } from './features.service'

@Controller('bindings/:bindingId')
export class FeaturesController {
  constructor(private readonly featuresService: FeaturesService) {}

  @Get('scores')
  getScores(@Param('bindingId') bindingId: string, @Query('termId') termId?: string) {
    return this.featuresService.getFeature(bindingId, 'score', termId)
  }

  @Get('exams')
  getExams(@Param('bindingId') bindingId: string, @Query('termId') termId?: string) {
    return this.featuresService.getFeature(bindingId, 'exam', termId)
  }

  @Get('profile')
  getProfile(@Param('bindingId') bindingId: string) {
    return this.featuresService.getFeature(bindingId, 'profile')
  }

  @Post('profile')
  saveProfile(
    @Param('bindingId') bindingId: string,
    @Body() input: { profile?: Record<string, unknown> },
  ) {
    return this.featuresService.saveProfile(bindingId, input.profile ?? {})
  }
}
