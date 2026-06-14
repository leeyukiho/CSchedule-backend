import { Module } from "@nestjs/common";

import { AccountsModule } from "../accounts/accounts.module";
import { ProvidersModule } from "../providers/providers.module";
import { CourseSyncService } from "./course-sync.service";
import { AccountSyncController, SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";

@Module({
  imports: [AccountsModule, ProvidersModule],
  controllers: [SyncController, AccountSyncController],
  providers: [SyncService, CourseSyncService],
  exports: [SyncService, CourseSyncService],
})
export class SyncModule {}
