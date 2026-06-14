import { Module } from '@nestjs/common'

import { PrismaModule } from '../../common/prisma/prisma.module'
import { StudentAccountController } from './accounts.controller'
import { StudentAccountsService } from './accounts.service'
import { StudentIdentityService } from './student-identity.service'

@Module({
  imports: [PrismaModule],
  controllers: [StudentAccountController],
  providers: [StudentAccountsService, StudentIdentityService],
  exports: [StudentAccountsService, StudentIdentityService],
})
export class AccountsModule {}
