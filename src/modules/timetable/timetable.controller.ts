import { Controller, Get, Param, Query } from '@nestjs/common'

import { TimetableService } from './timetable.service'

@Controller('account/:accountId/timetable')
export class TimetableController {
  constructor(private readonly timetableService: TimetableService) {}

  @Get()
  getTimetable(
    @Param('accountId') accountId: string,
    @Query('termId') termId?: string,
  ) {
    return this.timetableService.getTimetable(accountId, termId)
  }
}
