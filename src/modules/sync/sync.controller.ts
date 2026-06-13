import { Body, Controller, Get, Param, Post } from '@nestjs/common'

import { DataTarget } from '../providers/provider.types'
import { SyncService } from './sync.service'

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get(':jobId')
  getSyncJob(@Param('jobId') jobId: string) {
    return this.syncService.getSyncJob(jobId)
  }
}

@Controller('bindings/:bindingId/sync')
export class BindingSyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post(':target')
  createManualSync(
    @Param('bindingId') bindingId: string,
    @Param('target') target: DataTarget,
    @Body() input: { username?: string; password?: string; semesterId?: string } = {},
  ) {
    return this.syncService.createManualSync(bindingId, target, input)
  }
}
