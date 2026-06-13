import { Module } from '@nestjs/common'

import { ProvidersModule } from '../providers/providers.module'
import { CourseSyncService } from './course-sync.service'
import { BindingSyncController, SyncController } from './sync.controller'
import { SyncService } from './sync.service'

@Module({
  imports: [ProvidersModule],
  controllers: [SyncController, BindingSyncController],
  providers: [SyncService, CourseSyncService],
  exports: [SyncService, CourseSyncService],
})
export class SyncModule {}
