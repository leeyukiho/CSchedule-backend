import { Controller, Delete, Get, Param } from '@nestjs/common'

import { StudentAccountsService } from './accounts.service'

@Controller('account')
export class StudentAccountController {
  constructor(private readonly accountsService: StudentAccountsService) {}

  @Get()
  listAccounts() {
    return this.accountsService.listAccounts()
  }

  @Get(':accountId')
  getAccount(@Param('accountId') accountId: string) {
    return this.accountsService.getAccount(accountId)
  }

  @Delete(':accountId')
  deactivateAccount(@Param('accountId') accountId: string) {
    return this.accountsService.deactivateAccount(accountId)
  }
}
