import axios, { AxiosHeaders } from 'axios'
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http'
import { CookieJar } from 'tough-cookie'

export function createProviderHttpClient(input: {
  baseUrl: string
  timeout?: number
  rejectUnauthorized?: boolean
}) {
  const jar = new CookieJar()
  const client = axios.create({
    adapter: 'http',
    baseURL: input.baseUrl,
    httpAgent: new HttpCookieAgent({ cookies: { jar } }),
    httpsAgent: new HttpsCookieAgent({
      cookies: { jar },
      ...(input.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    }),
    withCredentials: true,
    timeout: input.timeout ?? 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 MiniProgram Schedule Fetcher',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  })

  client.interceptors.request.use((config) => {
    const requestUrl = resolveRequestUrl(config.baseURL || input.baseUrl, config.url)
    const cookieHeader = jar.getCookieStringSync(requestUrl)

    if (cookieHeader) {
      const headers = AxiosHeaders.from(config.headers)
      headers.set('Cookie', cookieHeader)
      config.headers = headers
    }

    return config
  })

  client.interceptors.response.use((response) => {
    const requestUrl = resolveRequestUrl(response.config.baseURL || input.baseUrl, response.config.url)

    for (const cookie of [response.headers['set-cookie']].flat()) {
      if (cookie) {
        jar.setCookieSync(String(cookie), requestUrl, { ignoreError: true })
      }
    }

    return response
  })

  return client
}

function resolveRequestUrl(baseUrl: string, requestUrl?: string) {
  return new URL(requestUrl || '', baseUrl).toString()
}
