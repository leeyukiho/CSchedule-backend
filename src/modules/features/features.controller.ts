import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'

import { FeaturesService } from './features.service'

@Controller('account/:accountId')
export class FeaturesController {
  constructor(private readonly featuresService: FeaturesService) {}

  @Get('scores')
  getScores(
    @Param('accountId') accountId: string,
    @Query('termId') termId?: string,
    @Query('knownHash') knownHash?: string,
  ) {
    return this.featuresService.getFeature(accountId, 'score', termId, knownHash)
  }

  @Get('exams')
  getExams(
    @Param('accountId') accountId: string,
    @Query('termId') termId?: string,
    @Query('knownHash') knownHash?: string,
  ) {
    return this.featuresService.getFeature(accountId, 'exam', termId, knownHash)
  }

  @Get('profile')
  getProfile(
    @Param('accountId') accountId: string,
    @Query('knownHash') knownHash?: string,
  ) {
    return this.featuresService.getFeature(accountId, 'profile', undefined, knownHash)
  }

  @Post('profile')
  saveProfile(
    @Param('accountId') accountId: string,
    @Body() input: { profile?: Record<string, unknown> },
  ) {
    return this.featuresService.saveProfile(accountId, input.profile ?? {})
  }
}
