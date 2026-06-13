export interface CookieJarSnapshot {
  cookies: Array<{
    name: string
    value: string
    domain?: string
    path?: string
    expiresAt?: string
    httpOnly?: boolean
    secure?: boolean
  }>
}
