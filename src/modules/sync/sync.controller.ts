import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'

import { DataTarget } from '../providers/provider.types'
import { SyncService } from './sync.service'

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get(':jobId')
  getSyncJob(
    @Param('jobId') jobId: string,
    @Query('includeCache') includeCache?: string,
  ) {
    return this.syncService.getSyncJob(jobId, includeCache === '1' || includeCache === 'true')
  }
}

@Controller('account/:accountId/sync')
export class AccountSyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post(':target')
  createManualSync(
    @Param('accountId') accountId: string,
    @Param('target') target: DataTarget,
    @Body() input: { username?: string; password?: string; semesterId?: string } = {},
  ) {
    return this.syncService.createManualSync(accountId, target, input)
  }
}
