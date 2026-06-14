import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { PrismaModule } from './common/prisma/prisma.module'
import { AuthModule } from './modules/auth/auth.module'
import { AdminModule } from './modules/admin/admin.module'
import { AccountsModule } from './modules/accounts/accounts.module'
import { FeaturesModule } from './modules/features/features.module'
import { FeedbackModule } from './modules/feedback/feedback.module'
import { HealthModule } from './modules/health/health.module'
import { ProvidersModule } from './modules/providers/providers.module'
import { RawDataModule } from './modules/raw-data/raw-data.module'
import { SchoolsModule } from './modules/schools/schools.module'
import { SubmissionsModule } from './modules/submissions/submissions.module'
import { SyncModule } from './modules/sync/sync.module'
import { TimetableModule } from './modules/timetable/timetable.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    HealthModule,
    ProvidersModule,
    SchoolsModule,
    AuthModule,
    AccountsModule,
    TimetableModule,
    FeaturesModule,
    SyncModule,
    RawDataModule,
    FeedbackModule,
    SubmissionsModule,
    AdminModule,
  ],
})
export class AppModule {}
