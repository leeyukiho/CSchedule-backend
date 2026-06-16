import { Module } from "@nestjs/common";

import { CredentialVaultService } from "../../common/crypto/credential-vault.service";
import { AccountsModule } from "../accounts/accounts.module";
import { ProvidersModule } from "../providers/providers.module";
import { AutoSyncScheduler } from "./auto-sync.scheduler";
import { CloudSyncWorkerService } from "./cloud-sync-worker.service";
import { CourseSyncService } from "./course-sync.service";
import { AccountSyncController, SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";

@Module({
  imports: [AccountsModule, ProvidersModule],
  controllers: [SyncController, AccountSyncController],
  providers: [
    SyncService,
    CourseSyncService,
    CloudSyncWorkerService,
    AutoSyncScheduler,
    CredentialVaultService,
  ],
  exports: [SyncService, CourseSyncService],
})
export class SyncModule {}
