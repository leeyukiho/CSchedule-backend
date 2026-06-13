import { Controller, Get, Param, Query } from '@nestjs/common'

import { TimetableService } from './timetable.service'

@Controller('bindings/:bindingId/timetable')
export class TimetableController {
  constructor(private readonly timetableService: TimetableService) {}

  @Get()
  getTimetable(
    @Param('bindingId') bindingId: string,
    @Query('termId') termId?: string,
  ) {
    return this.timetableService.getTimetable(bindingId, termId)
  }
}
