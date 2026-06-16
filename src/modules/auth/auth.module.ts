import { Module } from "@nestjs/common";

import { CredentialVaultService } from "../../common/crypto/credential-vault.service";
import { AccountsModule } from "../accounts/accounts.module";
import { ProvidersModule } from "../providers/providers.module";
import { SyncModule } from "../sync/sync.module";
import { AuthController, SessionImportController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({
  imports: [AccountsModule, ProvidersModule, SyncModule],
  controllers: [AuthController, SessionImportController],
  providers: [AuthService, CredentialVaultService],
  exports: [AuthService],
})
export class AuthModule {}
