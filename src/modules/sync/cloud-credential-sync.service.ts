import { BadRequestException, Injectable } from '@nestjs/common'
import * as cloudbase from '@cloudbase/node-sdk'

import {
  CloudSyncFunctionConfig,
  CloudSyncFunctionMap,
  DataTarget,
} from '../providers/provider.types'

export interface CloudCredentialCacheResult {
  target: DataTarget
  termId?: string
  cacheData: Record<string, unknown>
  parsedCount?: number
  sourceHash?: string
  syncedAt?: string
  warnings?: string[]
}

export interface CloudCredentialSyncResult {
  targets?: DataTarget[]
  termId?: string
  cacheResults: CloudCredentialCacheResult[]
  parsedCount?: number
  sourceHash?: string
  warnings?: string[]
  profile?: unknown
}

interface CloudCredentialSyncResponse {
  ok?: boolean
  result?: CloudCredentialSyncResult
  data?: CloudCredentialSyncResult
  errorCode?: string
  errorMessage?: string
}

interface CloudCredentialSyncPayload {
  source: 'backend_auto_sync'
  schoolId: string
  providerId: string
  targets: DataTarget[]
  username: string
  password: string
  semesterId?: string
  workerSecret?: string
}

@Injectable()
export class CloudCredentialSyncService {
  private app: ReturnType<typeof cloudbase.init> | null = null
  private appCredentialSignature = ''

  isTargetConfigured(config: unknown, target: DataTarget) {
    return Boolean(this.getCloudFunction(config, target))
  }

  canRunTarget(config: unknown, target: DataTarget) {
    const cloudFunction = this.getCloudFunction(config, target)

    return Boolean(
      cloudFunction?.url ||
        (cloudFunction?.functionName && this.getCloudBaseEnv()),
    )
  }

  async syncByCredentials(input: {
    schoolId: string
    providerId: string
    targets: DataTarget[]
    username: string
    password: string
    semesterId?: string
    config: unknown
  }): Promise<CloudCredentialSyncResult> {
    const targets = this.normalizeTargets(input.targets)

    if (!targets.length) {
      throw new BadRequestException(
        'CLOUD_SYNC_TARGETS_INVALID: at least one target is required',
      )
    }

    const cloudFunction = this.getSharedCloudFunction(input.config, targets)

    if (!cloudFunction) {
      throw new BadRequestException(
        'CLOUD_SYNC_NOT_CONFIGURED: requested targets have no shared cloud sync function',
      )
    }

    const payload: CloudCredentialSyncPayload = {
      source: 'backend_auto_sync',
      schoolId: input.schoolId,
      providerId: input.providerId,
      targets,
      username: input.username,
      password: input.password,
      ...(input.semesterId ? { semesterId: input.semesterId } : {}),
      ...(process.env.CSCHEDULE_WORKER_SECRET
        ? { workerSecret: process.env.CSCHEDULE_WORKER_SECRET }
        : {}),
    }
    const response = cloudFunction.url
      ? await this.callHttpFunction(cloudFunction.url, payload)
      : await this.callCloudBaseFunction(
          this.getFunctionName(cloudFunction),
          payload,
        )

    return this.unwrapSyncResult(response)
  }

  getCloudFunction(config: unknown, target: DataTarget) {
    return this.getCloudSyncFunctions(config)[target]
  }

  getSharedCloudFunction(config: unknown, targets: DataTarget[]) {
    const functions = this.getCloudSyncFunctions(config)
    const configured = targets.map((target) => functions[target])

    if (configured.some((item) => !item)) {
      return undefined
    }

    const [first] = configured

    if (!first) {
      return undefined
    }

    return configured.every((item) => this.isSameCloudFunction(first, item))
      ? first
      : undefined
  }

  getCloudSyncFunctions(config: unknown): CloudSyncFunctionMap {
    const root = this.asRecord(config)
    const provider = this.asRecord(root.provider)
    const source = this.asRecord(root.cloudFunctions ?? provider.cloudFunctions)
    const result: CloudSyncFunctionMap = {}

    for (const target of ['course', 'score', 'exam', 'profile'] as DataTarget[]) {
      const value = source[target]

      if (typeof value === 'string' && value.trim()) {
        result[target] = { functionName: value.trim() }
        continue
      }

      const record = this.asRecord(value)
      const functionName = record.functionName
      const url = record.url

      if (
        (typeof functionName === 'string' && functionName.trim()) ||
        (typeof url === 'string' && url.trim())
      ) {
        result[target] = {
          ...(typeof functionName === 'string' && functionName.trim()
            ? { functionName: functionName.trim() }
            : {}),
          ...(typeof url === 'string' && url.trim() ? { url: url.trim() } : {}),
        }
      }
    }

    return result
  }

  private async callHttpFunction(
    url: string,
    payload: CloudCredentialSyncPayload,
  ) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.CSCHEDULE_WORKER_SECRET
          ? { 'x-cschedule-worker-secret': process.env.CSCHEDULE_WORKER_SECRET }
          : {}),
      },
      body: JSON.stringify(payload),
    })
    const data = await response.json().catch(() => null)

    if (!response.ok) {
      throw new Error(
        `CLOUD_SYNC_FAILED: ${response.status} ${this.getErrorMessage(data)}`,
      )
    }

    return data
  }

  private async callCloudBaseFunction(
    functionName: string,
    payload: CloudCredentialSyncPayload,
  ) {
    const env = this.getCloudBaseEnv()

    if (!env) {
      throw new Error('CLOUD_SYNC_ENV_NOT_CONFIGURED')
    }

    const response = await this.getCloudBaseApp(env).callFunction<
      CloudCredentialSyncPayload,
      CloudCredentialSyncResponse | CloudCredentialSyncResult
    >({
      name: functionName,
      data: payload,
    })

    return response.result
  }

  private getFunctionName(cloudFunction: CloudSyncFunctionConfig) {
    if (!cloudFunction.functionName) {
      throw new Error('CLOUD_SYNC_FUNCTION_NOT_CONFIGURED')
    }

    return cloudFunction.functionName
  }

  private getCloudBaseApp(env: string) {
    const credentials = this.getCloudBaseCredentials()
    const credentialSignature = JSON.stringify(credentials)

    if (!this.app || this.appCredentialSignature !== credentialSignature) {
      this.clearSessionTokenEnvWhenUsingLongLivedCredentials()
      this.app = cloudbase.init({
        env,
        ...credentials,
      })
      this.appCredentialSignature = credentialSignature
    }

    return this.app
  }

  private getCloudBaseCredentials() {
    const secretId = process.env.TENCENTCLOUD_SECRETID
    const secretKey = process.env.TENCENTCLOUD_SECRETKEY

    return {
      ...(secretId ? { secretId } : {}),
      ...(secretKey ? { secretKey } : {}),
      ...(!secretId && !secretKey && this.hasUsableSessionToken()
        ? { sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }
        : {}),
    }
  }

  private clearSessionTokenEnvWhenUsingLongLivedCredentials() {
    if (!process.env.TENCENTCLOUD_SECRETID || !process.env.TENCENTCLOUD_SECRETKEY) {
      return
    }

    delete process.env.TENCENTCLOUD_SESSIONTOKEN
    delete process.env.TENCENTCLOUD_CREDENTIAL_EXPIRES_AT
  }

  private hasUsableSessionToken() {
    if (!process.env.TENCENTCLOUD_SESSIONTOKEN) {
      return false
    }

    const expiresAt = this.getCredentialExpiresAt()

    return !expiresAt || expiresAt.getTime() > Date.now() + 60_000
  }

  private getCredentialExpiresAt() {
    const rawValue = process.env.TENCENTCLOUD_CREDENTIAL_EXPIRES_AT

    if (!rawValue) {
      return null
    }

    const expiresAt = new Date(rawValue)

    return Number.isNaN(expiresAt.getTime()) ? null : expiresAt
  }

  private getCloudBaseEnv() {
    return (
      process.env.CLOUDBASE_ENV_ID ||
      process.env.TCB_ENV_ID ||
      process.env.TARO_APP_CLOUDBASE_ENV_ID ||
      ''
    )
  }

  private unwrapSyncResult(response: unknown): CloudCredentialSyncResult {
    const data = this.asRecord(response) as CloudCredentialSyncResponse

    if (data.ok === false || data.errorCode) {
      throw new Error(data.errorCode || data.errorMessage || 'CLOUD_SYNC_FAILED')
    }

    const result = (data.result || data.data || response) as CloudCredentialSyncResult

    if (!Array.isArray(result.cacheResults) || result.cacheResults.length === 0) {
      throw new Error('CLOUD_SYNC_EMPTY_RESULT')
    }

    const cacheResults = result.cacheResults.flatMap((item) => {
      if (
        !(
          item &&
          ['course', 'score', 'exam', 'profile'].includes(item.target) &&
          item.cacheData &&
          typeof item.cacheData === 'object' &&
          !Array.isArray(item.cacheData)
        )
      ) {
        return []
      }

      return [
        {
          ...item,
          cacheData: this.withCacheResultMeta(item),
        },
      ]
    })

    if (cacheResults.length === 0) {
      throw new Error('CLOUD_SYNC_EMPTY_RESULT')
    }

    return { ...result, cacheResults }
  }

  private withCacheResultMeta(
    cacheResult: CloudCredentialCacheResult,
  ): Record<string, unknown> {
    return {
      ...cacheResult.cacheData,
      ...(cacheResult.termId ? { termId: cacheResult.termId } : {}),
      ...(cacheResult.sourceHash ? { sourceHash: cacheResult.sourceHash } : {}),
      ...(cacheResult.syncedAt ? { syncedAt: cacheResult.syncedAt } : {}),
    }
  }

  private getErrorMessage(data: unknown) {
    const record = this.asRecord(data)

    return String(record.errorMessage || record.errorCode || '').trim()
  }

  private normalizeTargets(targets: DataTarget[]) {
    return [...new Set(
      (Array.isArray(targets) ? targets : []).filter((target): target is DataTarget =>
        ['course', 'score', 'exam', 'profile'].includes(target),
      ),
    )]
  }

  private isSameCloudFunction(
    left: CloudSyncFunctionConfig | undefined,
    right: CloudSyncFunctionConfig | undefined,
  ) {
    return Boolean(
      left &&
        right &&
        (left.functionName || '') === (right.functionName || '') &&
        (left.url || '') === (right.url || ''),
    )
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
}
