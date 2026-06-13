import { Module } from '@nestjs/common'

import { ProvidersModule } from '../providers/providers.module'
import { CourseSyncService } from '../sync/course-sync.service'
import { AuthController, SessionImportController } from './auth.controller'
import { AuthService } from './auth.service'

@Module({
  imports: [ProvidersModule],
  controllers: [AuthController, SessionImportController],
  providers: [AuthService, CourseSyncService],
  exports: [AuthService],
})
export class AuthModule {}
