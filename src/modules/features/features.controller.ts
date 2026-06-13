import { Controller, Get, Param, Query } from '@nestjs/common'

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
}

