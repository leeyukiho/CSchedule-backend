export interface HttpClientRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: unknown
}

export interface HttpClientResponse<T = unknown> {
  status: number
  headers: Record<string, string>
  data: T
}
