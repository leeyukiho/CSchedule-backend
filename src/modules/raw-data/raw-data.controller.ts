import { Body, Controller, Param, Post, UsePipes, ValidationPipe } from '@nestjs/common'

import { RawDataService } from './raw-data.service'
import {
  CompleteWebviewSyncDto,
  RawCourseUploadDto,
  RawDataUploadDto,
} from './raw-data.dto'

@Controller('account/:accountId')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  }),
)
export class RawDataController {
  constructor(private readonly rawDataService: RawDataService) {}

  @Post('raw-data')
  uploadRawData(
    @Param('accountId') accountId: string,
    @Body() input: RawDataUploadDto,
  ) {
    return this.rawDataService.uploadRawData(accountId, input)
  }

  @Post('raw-course')
  uploadRawCourse(
    @Param('accountId') accountId: string,
    @Body() input: RawCourseUploadDto,
  ) {
    return this.rawDataService.uploadRawData(accountId, {
      ...input,
      target: 'course',
    })
  }

  @Post('webview-sync/complete')
  completeWebviewSync(
    @Param('accountId') accountId: string,
    @Body() input: CompleteWebviewSyncDto,
  ) {
    return this.rawDataService.completeWebviewSync(accountId, input.completedTargets)
  }
}
