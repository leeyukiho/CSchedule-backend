import { Body, Controller, Param, Post } from '@nestjs/common'

import { DataTarget } from '../providers/provider.types'
import { RawDataService, RawDataUploadRequest } from './raw-data.service'

@Controller('account/:accountId')
export class RawDataController {
  constructor(private readonly rawDataService: RawDataService) {}

  @Post('raw-data')
  uploadRawData(
    @Param('accountId') accountId: string,
    @Body() input: RawDataUploadRequest,
  ) {
    return this.rawDataService.uploadRawData(accountId, input)
  }

  @Post('raw-course')
  uploadRawCourse(
    @Param('accountId') accountId: string,
    @Body() input: Omit<RawDataUploadRequest, 'target'>,
  ) {
    return this.rawDataService.uploadRawData(accountId, {
      ...input,
      target: 'course',
    })
  }

  @Post('webview-sync/complete')
  completeWebviewSync(
    @Param('accountId') accountId: string,
    @Body() input: { completedTargets?: DataTarget[] },
  ) {
    return this.rawDataService.completeWebviewSync(accountId, input.completedTargets)
  }
}
