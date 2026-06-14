import { Module } from '@nestjs/common'

import { ProvidersModule } from '../providers/providers.module'
import { TimetableController } from './timetable.controller'
import { TimetableService } from './timetable.service'

@Module({
  imports: [ProvidersModule],
  controllers: [TimetableController],
  providers: [TimetableService],
  exports: [TimetableService],
})
export class TimetableModule {}
