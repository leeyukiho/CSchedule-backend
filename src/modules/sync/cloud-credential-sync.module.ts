import { Module } from "@nestjs/common";

import { CloudCredentialSyncService } from "./cloud-credential-sync.service";

@Module({
  providers: [CloudCredentialSyncService],
  exports: [CloudCredentialSyncService],
})
export class CloudCredentialSyncModule {}
