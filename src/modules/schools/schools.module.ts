import { Module } from '@nestjs/common'

import { ProvidersModule } from '../providers/providers.module'
import { SchoolsController } from './schools.controller'
import { SchoolsService } from './schools.service'

@Module({
  imports: [ProvidersModule],
  controllers: [SchoolsController],
  providers: [SchoolsService],
  exports: [SchoolsService],
})
export class SchoolsModule {}
