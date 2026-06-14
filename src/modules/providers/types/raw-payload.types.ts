import { DataAccessMode, DataTarget } from '../provider.types'

export interface RawPayloadEnvelope {
  schoolId: string
  providerId: string
  accountId: string
  target: DataTarget
  accessMode: Extract<DataAccessMode, 'webview_client_fetch' | 'manual_import'>
  termId?: string
  contentType: 'json' | 'html' | 'text' | 'csv' | 'xlsx' | 'ics' | 'pdf'
  payload: unknown
  capturedAt: string
  sourceUrl?: string
  sourceHash: string
}
