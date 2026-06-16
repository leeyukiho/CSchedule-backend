import { Injectable } from '@nestjs/common'

import { DataTarget } from '../providers/provider.types'

export interface CloudSyncWorkerRequest {
  accountId: string
  schoolId: string
  providerId: string
  target: DataTarget
  username: string
  password: string
  semesterId?: string
}

export interface CloudSyncWorkerResponse {
  ok?: boolean
  unsupported?: boolean
  result?: unknown
  errorCode?: string
  errorMessage?: string
}

@Injectable()
export class CloudSyncWorkerService {
  private readonly endpoint = process.env.CLOUD_SYNC_WORKER_URL || ''
  private readonly secret = process.env.CLOUD_SYNC_WORKER_SECRET || ''

  isEnabled() {
    return Boolean(this.endpoint)
  }

  async runProviderSync(input: CloudSyncWorkerRequest) {
    if (!this.endpoint) {
      return { ok: false, unsupported: true, errorCode: 'CLOUD_WORKER_NOT_CONFIGURED' }
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.secret ? { 'x-cschedule-worker-secret': this.secret } : {}),
      },
      body: JSON.stringify({
        ...input,
        ...(this.secret ? { workerSecret: this.secret } : {}),
      }),
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      return {
        ok: false,
        errorCode: `CLOUD_WORKER_HTTP_${response.status}`,
        errorMessage: JSON.stringify(payload),
      }
    }

    return payload as CloudSyncWorkerResponse
  }
}
