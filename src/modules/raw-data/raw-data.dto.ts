import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator'

import { DataTarget } from '../providers/provider.types'
import { RawDataUploadRequest } from './raw-data.service'

const DATA_TARGETS = ['course', 'score', 'exam', 'profile'] as const
const RAW_DATA_ACCESS_MODES = ['webview_client_fetch', 'manual_import'] as const
const RAW_DATA_CONTENT_TYPES = [
  'json',
  'html',
  'text',
  'csv',
  'xlsx',
  'ics',
  'pdf',
] as const
const RAW_DATA_RESPONSE_MODES = ['full', 'status_only'] as const
const MAX_CONTEXT_ID_LENGTH = 128
const MAX_TERM_ID_LENGTH = 128
const MAX_SOURCE_URL_LENGTH = 2048

export class RawDataUploadDto implements RawDataUploadRequest {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTEXT_ID_LENGTH)
  contextId?: string

  @IsIn(DATA_TARGETS)
  target!: DataTarget

  @IsIn(RAW_DATA_ACCESS_MODES)
  accessMode!: RawDataUploadRequest['accessMode']

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TERM_ID_LENGTH)
  termId?: string

  @IsIn(RAW_DATA_CONTENT_TYPES)
  contentType!: RawDataUploadRequest['contentType']

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SOURCE_URL_LENGTH)
  sourceUrl?: string

  @IsDefined()
  payload!: unknown

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(DATA_TARGETS, { each: true })
  completedTargets?: DataTarget[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(DATA_TARGETS, { each: true })
  requiredTargets?: DataTarget[]

  @IsOptional()
  @IsIn(RAW_DATA_RESPONSE_MODES)
  responseMode?: RawDataUploadRequest['responseMode']

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>
}

export class RawCourseUploadDto implements Omit<RawDataUploadRequest, 'target'> {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTEXT_ID_LENGTH)
  contextId?: string

  @IsIn(RAW_DATA_ACCESS_MODES)
  accessMode!: RawDataUploadRequest['accessMode']

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TERM_ID_LENGTH)
  termId?: string

  @IsIn(RAW_DATA_CONTENT_TYPES)
  contentType!: RawDataUploadRequest['contentType']

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SOURCE_URL_LENGTH)
  sourceUrl?: string

  @IsDefined()
  payload!: unknown

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(DATA_TARGETS, { each: true })
  completedTargets?: DataTarget[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(DATA_TARGETS, { each: true })
  requiredTargets?: DataTarget[]

  @IsOptional()
  @IsIn(RAW_DATA_RESPONSE_MODES)
  responseMode?: RawDataUploadRequest['responseMode']

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>
}

export class CompleteWebviewSyncDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(DATA_TARGETS, { each: true })
  completedTargets?: DataTarget[]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(DATA_TARGETS, { each: true })
  requiredTargets?: DataTarget[]
}
