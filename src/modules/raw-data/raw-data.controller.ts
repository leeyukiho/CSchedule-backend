import { Body, Controller, Param, Post } from '@nestjs/common'

import { DataTarget } from '../providers/provider.types'
import { RawDataService, RawDataUploadRequest } from './raw-data.service'

@Controller('bindings/:bindingId')
export class RawDataController {
  constructor(private readonly rawDataService: RawDataService) {}

  @Post('raw-data')
  uploadRawData(
    @Param('bindingId') bindingId: string,
    @Body() input: RawDataUploadRequest,
  ) {
    return this.rawDataService.uploadRawData(bindingId, input)
  }

  @Post('raw-course')
  uploadRawCourse(
    @Param('bindingId') bindingId: string,
    @Body() input: Omit<RawDataUploadRequest, 'target'>,
  ) {
    return this.rawDataService.uploadRawData(bindingId, {
      ...input,
      target: 'course',
    })
  }

  @Post('webview-sync/complete')
  completeWebviewSync(
    @Param('bindingId') bindingId: string,
    @Body() input: { completedTargets?: DataTarget[] },
  ) {
    return this.rawDataService.completeWebviewSync(bindingId, input.completedTargets)
  }
}

