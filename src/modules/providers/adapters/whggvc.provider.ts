import { AxiosHeaders } from 'axios'
import { createHash } from 'node:crypto'

import {
  CourseConnector,
  CourseFetchResult,
  FeatureFetchResult,
  ProviderCourse,
  ProviderProfile,
  ProviderSchedule,
  ProviderScoreResult,
  ProfileConnector,
  SchoolProvider,
  ScoreConnector,
} from '../provider.types'
import { createProviderHttpClient } from './provider-http'
import { cleanText, firstValue, maskStudentId } from './text-utils'

const DEFAULT_CONFIG = {
  apiBaseUrl: 'https://xs.whggvc.net/scloudoa',
  loginPath: '/sys/mLogin',
  menuPath: '/eoa/eoaAppStudentConfig/queryStudentAppConfigRoute',
  currentContextPath: '/userQuery/tSysUser/getCourseSchoolTimetable',
  lessonTimePath: '/scs/course/tCourseTimetableDetail/getCourseLessonTime',
  weeklyCoursePath:
    '/scs/course/tCourseTimetableDetail/getCourseTimeTableByWeek',
  scoreSemesterPath: '/scs/course/tCourseScore/getSemester',
  scorePath: '/scs/course/tCourseScore/getCourseScore',
  scoreSummaryPath: '/scs/course/tCourseScore/getSemesterScore',
  examPath: '/examQuery/tCourseExamShedule/list',
  profilePath: '/sys/user/queryById',
  tokenHeader: 'X-Access-Token',
  requestPageSize: 500,
  maxWeeks: 30,
  signAlgorithm: 'jeecg_md5_candidate',
  signSecret: 'dd05f1c54d63749eda95f9fa6d49v442a',
}

type WhggvcConfig = typeof DEFAULT_CONFIG

interface WhggvcLoginSession {
  token: string
  userId: string
  profile: ProviderProfile
  raw: unknown
}

interface WhggvcContext {
  currentSemester: string
  currentWeek: number
  totalWeeks: number
  termTitle: string
  startDate: string
  raw: unknown
}

function getConfig(providerConfig?: Record<string, unknown>): WhggvcConfig {
  const config = {
    ...DEFAULT_CONFIG,
    ...(providerConfig || {}),
  } as WhggvcConfig

  if (config.apiBaseUrl === 'https://scs.whggvc.net/scscloud') {
    config.apiBaseUrl = DEFAULT_CONFIG.apiBaseUrl
  }

  return config
}

function createWhggvcClient(config: WhggvcConfig) {
  const client = createProviderHttpClient({
    baseUrl: config.apiBaseUrl,
    timeout: 15000,
    rejectUnauthorized: false,
  })

  client.interceptors.request.use((request) => {
    const timestamp = formatWhggvcTimestamp()
    const headers = AxiosHeaders.from(request.headers)
    const requestPath = resolveRequestPath(
      request.baseURL || config.apiBaseUrl,
      request.url,
    )
    const sign = createWhggvcSign({
      path: requestPath,
      params: request.params,
      secret: config.signSecret,
    })

    headers.set('X-TIMESTAMP', timestamp)
    headers.set('X-Sign', sign)
    headers.set('Accept', 'application/json, text/plain, */*')

    request.headers = headers
    return request
  })

  return client
}

function resolveRequestPath(baseUrl: string, requestUrl?: string) {
  const url = new URL(requestUrl || '', baseUrl)
  return `${url.pathname}${url.search}`
}

function createWhggvcSign(input: {
  path: string
  params?: unknown
  secret?: string
}) {
  const payload = {
    ...parseQueryParams(input.path),
    ...asRecord(input.params),
    ...parsePathVariable(input.path),
  }
  const sortedPayload = sortRecord(payload)

  return createHash('md5')
    .update(JSON.stringify(sortedPayload) + (input.secret || ''))
    .digest('hex')
    .toUpperCase()
}

function formatWhggvcTimestamp() {
  const date = new Date()
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ]

  return parts
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, '0'),
    )
    .join('')
}

function parseQueryParams(path: string) {
  const questionIndex = path.indexOf('?')

  if (questionIndex < 0) {
    return {}
  }

  return Object.fromEntries(new URLSearchParams(path.slice(questionIndex + 1)))
}

function parsePathVariable(path: string) {
  const pathWithoutQuery = path.split('?')[0] || ''
  const lastSegment = pathWithoutQuery.slice(
    pathWithoutQuery.lastIndexOf('/') + 1,
  )

  if (!lastSegment.includes(',')) {
    return {}
  }

  return { 'x-path-variable': decodeURIComponent(lastSegment) }
}

function sortRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined && record[key] !== null)
      .sort()
      .map((key) => [key, normalizeSignValue(record[key])]),
  )
}

function normalizeSignValue(value: unknown) {
  return typeof value === 'number' && !Number.isNaN(value)
    ? String(value)
    : value
}

async function login(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
  username: string,
  password: string,
): Promise<WhggvcLoginSession> {
  const response = await client.post(
    config.loginPath,
    {
      username: username.trim(),
      password,
    },
    {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    },
  )
  assertLoginSucceeded(response.data)
  const token = extractToken(response.data, response.headers)

  if (!token) {
    throw new Error(
      `WHGGVC login response did not include an access token (${describeLoginResponse(
        response.data,
        response.headers,
      )})`,
    )
  }

  client.defaults.headers.common[config.tokenHeader] = token

  const payload = asRecord(unwrapResult(response.data))
  const user = asRecord(
    firstValue(payload.userInfo, payload.user, payload.sysUser, payload),
  )
  const userId = cleanText(
    firstValue(user.id, user.userId, payload.userid, payload.userId),
  )
  const studentId = cleanText(firstValue(user.username, user.workNo, username))
  const profile = normalizeProfile(user, studentId)

  await client.get(config.menuPath).catch(() => undefined)

  return {
    token,
    userId,
    profile,
    raw: response.data,
  }
}

function extractToken(data: unknown, headers: unknown) {
  const payload = asRecord(unwrapResult(data))
  const root = asRecord(data)

  return normalizeTokenValue(
    firstValue(
      findTokenValue(payload),
      findTokenValue(root),
      findTokenValue(asRecord(headers)),
    ),
  )
}

function assertLoginSucceeded(data: unknown) {
  const root = asRecord(data)
  const code = firstValue(root.code, root.status)
  const success = root.success

  if (success === false || (code && !['0', '200'].includes(cleanText(code)))) {
    throw new Error(
      `WHGGVC login failed: ${describeLoginResponse(data, undefined)}`,
    )
  }
}

function describeLoginResponse(data: unknown, headers: unknown) {
  const root = asRecord(data)
  const payload = asRecord(unwrapResult(data))
  const message = cleanText(
    firstValue(root.message, root.msg, payload.message, payload.msg),
  )
  const code = cleanText(firstValue(root.code, root.status, payload.code))
  const success = typeof root.success === 'boolean' ? String(root.success) : ''
  const keys = Object.keys(root).slice(0, 12).join(',')
  const payloadKeys =
    payload !== root ? Object.keys(payload).slice(0, 12).join(',') : ''
  const headerKeys = headers ? Object.keys(asRecord(headers)).join(',') : ''
  const parts = [
    code ? `code=${code}` : '',
    success ? `success=${success}` : '',
    message ? `message=${message}` : '',
    keys ? `keys=${keys}` : '',
    payloadKeys ? `payloadKeys=${payloadKeys}` : '',
    headerKeys ? `headerKeys=${headerKeys}` : '',
  ].filter(Boolean)

  return parts.join('; ') || 'empty response'
}

const TOKEN_FIELD_NAMES = [
  'token',
  'accessToken',
  'access_token',
  'ACCESS_TOKEN',
  'xAccessToken',
  'X-Access-Token',
  'x-access-token',
  'idToken',
  'id_token',
  'jwt',
  'Authorization',
  'authorization',
]

const TOKEN_CONTAINER_FIELD_NAMES = [
  'result',
  'data',
  'body',
  'userInfo',
  'user',
  'sysUser',
]

function findTokenValue(record: Record<string, unknown>, depth = 0): unknown {
  for (const fieldName of TOKEN_FIELD_NAMES) {
    const value = getCaseInsensitiveValue(record, fieldName)

    if (cleanText(value)) {
      return value
    }
  }

  if (depth >= 2) {
    return ''
  }

  for (const fieldName of TOKEN_CONTAINER_FIELD_NAMES) {
    const value = findTokenValue(
      asRecord(getCaseInsensitiveValue(record, fieldName)),
      depth + 1,
    )

    if (cleanText(value)) {
      return value
    }
  }

  return ''
}

function getCaseInsensitiveValue(
  record: Record<string, unknown>,
  fieldName: string,
) {
  if (fieldName in record) {
    return record[fieldName]
  }

  const normalizedFieldName = fieldName.toLowerCase()
  const matchingKey = Object.keys(record).find(
    (key) => key.toLowerCase() === normalizedFieldName,
  )

  return matchingKey ? record[matchingKey] : ''
}

function normalizeTokenValue(value: unknown) {
  const text = cleanText(value)
  const bearerMatch = text.match(/^Bearer\s+(.+)$/i)

  return bearerMatch ? bearerMatch[1].trim() : text
}

async function fetchCurrentContext(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
): Promise<WhggvcContext> {
  const response = await client.get(config.currentContextPath)
  const payload = asRecord(unwrapResult(response.data))
  const currentSemester = cleanText(
    firstValue(
      payload.currentSemester,
      payload.semester,
      payload.semesterId,
      payload.xq,
      payload.term,
    ),
  )
  const currentWeek = toPositiveNumber(
    firstValue(payload.nowWeek, payload.currentWeek, payload.week),
    1,
  )
  const totalWeeks = Math.min(
    toPositiveNumber(
      firstValue(payload.totalWeek, payload.totalWeeks, payload.weekCount),
      20,
    ),
    config.maxWeeks,
  )

  return {
    currentSemester,
    currentWeek,
    totalWeeks,
    termTitle: cleanText(
      firstValue(payload.semesterName, payload.termName, currentSemester),
    ),
    startDate: cleanText(
      firstValue(payload.startDate, payload.startTime, payload.openingDate),
    ),
    raw: response.data,
  }
}

async function fetchLessonTimes(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
) {
  const response = await client.get(config.lessonTimePath)

  return asList(unwrapResult(response.data)).map((item, index) => {
    const row = asRecord(item)
    const section = toPositiveNumber(
      firstValue(row.lesson, row.lessonScope, row.section, row.sort, row.index),
      index + 1,
    )

    return {
      section,
      startTime: cleanText(firstValue(row.startTime, row.start, row.kssj)),
      endTime: cleanText(firstValue(row.endTime, row.end, row.jssj)),
      source: row,
    }
  })
}

async function fetchWeeklyCourses(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
  input: { currentSemester: string; week: number },
) {
  const response = await client.get(config.weeklyCoursePath, {
    params: {
      current: 1,
      size: config.requestPageSize,
      currentSemester: input.currentSemester,
      nowWeek: input.week,
    },
  })

  return asList(unwrapResult(response.data)).map((item, index) =>
    normalizeWeeklyCourse(item, input.week, index),
  )
}

function normalizeWeeklyCourse(
  value: unknown,
  week: number,
  index: number,
): ProviderCourse | null {
  const row = asRecord(value)
  const name = cleanText(row.courseName)

  if (!name) {
    return null
  }

  const startSection = toPositiveNumber(row.startLessonScope, 0)
  const endSection = toPositiveNumber(row.endLessonScope, startSection)
  const sections =
    startSection > 0
      ? Array.from(
          { length: Math.max(endSection - startSection + 1, 1) },
          (_, sectionIndex) => startSection + sectionIndex,
        )
      : []
  const classroom = cleanText(firstValue(row.classroomName, row.classRoom))
  const teacher = cleanText(
    firstValue(row.teacherNames, row.teacherName, row.teacher),
  )
  const weekday = parseWeekday(row.week)

  return {
    id: cleanText(row.id) || `whggvc-${week}-${index + 1}`,
    name,
    teacher,
    location: classroom,
    classroom,
    weekday,
    sections,
    startSection: sections[0],
    endSection: sections[sections.length - 1],
    weeks: [week],
    rawWeeks: String(week),
    source: row,
  }
}

function mergeWeeklyCourses(courses: Array<ProviderCourse | null>) {
  const merged = new Map<string, ProviderCourse>()

  for (const course of courses) {
    if (!course) {
      continue
    }

    const key = [
      course.name,
      course.teacher || '',
      course.classroom || course.location || '',
      course.weekday,
      course.startSection || '',
      course.endSection || '',
    ].join('|')
    const existing = merged.get(key)

    if (!existing) {
      merged.set(key, course)
      continue
    }

    existing.weeks = [...new Set([...existing.weeks, ...course.weeks])].sort(
      (left, right) => left - right,
    )
    existing.rawWeeks = existing.weeks.join(',')
  }

  return [...merged.values()].sort((left, right) => {
    if (left.weekday !== right.weekday) {
      return left.weekday - right.weekday
    }

    return (left.startSection || 0) - (right.startSection || 0)
  })
}

async function fetchSchedule(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
  semesterId?: string,
): Promise<ProviderSchedule> {
  const context = await fetchCurrentContext(client, config)
  const currentSemester = semesterId || context.currentSemester

  if (!currentSemester) {
    throw new Error('WHGGVC current semester is missing')
  }

  const [sectionTimes, weeklyCourses] = await Promise.all([
    fetchLessonTimes(client, config).catch(() => []),
    Promise.all(
      Array.from({ length: context.totalWeeks }, (_, index) =>
        fetchWeeklyCourses(client, config, {
          currentSemester,
          week: index + 1,
        }).catch(() => []),
      ),
    ),
  ])
  const termTitle = context.termTitle || currentSemester

  return {
    term: termTitle,
    selectedSemesterId: currentSemester,
    semesters: [
      {
        id: currentSemester,
        title: termTitle,
        label: termTitle,
        selected: true,
      },
    ],
    courses: mergeWeeklyCourses(weeklyCourses.flat()),
    sectionTimes,
  }
}

async function fetchScoreSemesters(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
  fallbackSemester?: string,
) {
  const response = await client.get(config.scoreSemesterPath).catch(() => null)
  const semesters = asList(unwrapResult(response?.data)).map((item) => {
    const row = asRecord(item)
    const id = cleanText(
      firstValue(
        row.currentSemester,
        row.semester,
        row.semesterId,
        row.value,
        row.id,
      ),
    )
    const label = cleanText(
      firstValue(row.semesterName, row.label, row.name, id),
    )

    return id
      ? {
          id,
          title: label || id,
          label: label || id,
          selected: Boolean(
            row.selected || row.checked || id === fallbackSemester,
          ),
        }
      : null
  })

  const filtered = semesters.filter(Boolean) as Array<{
    id: string
    title: string
    label: string
    selected: boolean
  }>

  if (filtered.length || !fallbackSemester) {
    return filtered
  }

  return [
    {
      id: fallbackSemester,
      title: fallbackSemester,
      label: fallbackSemester,
      selected: true,
    },
  ]
}

async function fetchScores(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
  input: { semesterId?: string; allSemesters?: boolean },
): Promise<ProviderScoreResult> {
  const context = await fetchCurrentContext(client, config).catch(() => null)
  const fallbackSemester = input.semesterId || context?.currentSemester || ''
  const semesters = await fetchScoreSemesters(client, config, fallbackSemester)
  const targets = input.allSemesters
    ? semesters
    : semesters
        .filter((semester) => semester.id === fallbackSemester)
        .slice(0, 1)
  const selectedTargets = targets.length ? targets : semesters.slice(0, 1)

  const results = await Promise.all(
    selectedTargets.map(async (semester, index) => {
      const [scoreResponse, summaryResponse] = await Promise.all([
        client.get(config.scorePath, {
          params: {
            current: 1,
            size: config.requestPageSize,
            currentSemester: semester.id,
          },
        }),
        client
          .get(config.scoreSummaryPath, {
            params: { currentSemester: semester.id },
          })
          .catch(() => null),
      ])
      const grades = asList(unwrapResult(scoreResponse.data)).map(
        normalizeGrade,
      )
      const summary = asRecord(unwrapResult(summaryResponse?.data))

      return {
        id: semester.id,
        title: semester.label || semester.title || semester.id,
        credit: cleanText(
          firstValue(summary.credit, summary.totalCredit, '--'),
        ),
        average: cleanText(firstValue(summary.average, summary.avgScore, '--')),
        gpa: cleanText(firstValue(summary.getPoint, summary.gpa, '--')),
        expanded: index === 0,
        grades,
      }
    }),
  )

  return {
    summary: buildScoreSummary(results[0]),
    semesters: results,
  }
}

function normalizeGrade(value: unknown) {
  const row = asRecord(value)
  const score = cleanText(firstValue(row.finalScore, row.score, row.cj))
  const numericScore = Number(score)

  return {
    name: cleanText(row.courseName) || '未命名课程',
    credit: cleanText(firstValue(row.credit, row.getCredit, '')),
    score,
    scoreLow: Number.isFinite(numericScore) ? numericScore < 60 : false,
    gpa: cleanText(firstValue(row.getPoint, row.gpa, '')),
  }
}

function buildScoreSummary(
  semester?: ProviderScoreResult['semesters'][number],
) {
  if (!semester) {
    return [
      { label: '总学分', value: '--' },
      { label: '平均分', value: '--' },
      { label: '绩点', value: '--' },
    ]
  }

  return [
    { label: '总学分', value: semester.credit || '--' },
    { label: '平均分', value: semester.average || '--' },
    { label: '绩点', value: semester.gpa || '--' },
  ]
}

async function fetchExams(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
  semesterId?: string,
) {
  const context = await fetchCurrentContext(client, config).catch(() => null)
  const semester = semesterId || context?.currentSemester

  if (!semester) {
    return []
  }

  const response = await client.get(config.examPath, {
    params: {
      current: 1,
      size: config.requestPageSize,
      semester,
    },
  })

  return asList(unwrapResult(response.data)).map((item) => {
    const row = asRecord(item)

    return {
      name: cleanText(firstValue(row.resource, row.courseName)),
      date: cleanText(row.courseexamconfigschedulesessiondetailexamday),
      weekday: cleanText(row.courseexamconfigschedulesessiondetailweekday),
      startTime: cleanText(row.courseexamconfigschedulesessiondetailstarttime),
      endTime: cleanText(row.courseexamconfigschedulesessiondetailendtime),
      classroom: cleanText(row.classRoom),
      seatNumber: cleanText(row.seatNumbers),
      source: row,
    }
  })
}

async function fetchProfile(
  client: ReturnType<typeof createWhggvcClient>,
  config: WhggvcConfig,
  session: WhggvcLoginSession,
) {
  if (!session.userId) {
    return session.profile
  }

  const response = await client
    .get(config.profilePath, {
      params: { id: session.userId },
    })
    .catch(() => null)

  return response?.data
    ? normalizeProfile(
        asRecord(unwrapResult(response.data)),
        session.profile.studentId,
      )
    : session.profile
}

function normalizeProfile(
  value: Record<string, unknown>,
  fallbackStudentId?: unknown,
): ProviderProfile {
  const studentId = cleanText(
    firstValue(
      value.username,
      value.workNo,
      value.studentId,
      fallbackStudentId,
    ),
  )

  return {
    name: cleanText(firstValue(value.realname, value.name)),
    studentId,
    maskedStudentId: maskStudentId(studentId),
    role: cleanText(firstValue(value.identity, value.post, '学生')),
    gender: cleanText(value.sex),
    birthDate: cleanText(value.birthday),
    phone: cleanText(firstValue(value.phone, value.telephone)),
    email: cleanText(value.email),
    updatedAt: new Date().toISOString(),
  }
}

function parseWeekday(value: unknown) {
  const text = cleanText(value)
  const numeric = Number(text)

  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 7) {
    return numeric
  }

  const labels = ['一', '二', '三', '四', '五', '六', '日', '天']
  const index = labels.findIndex((label) => text.includes(label))

  return index >= 0 ? Math.min(index + 1, 7) : 0
}

function toPositiveNumber(value: unknown, fallback: number) {
  const numeric = Number(value)

  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

function unwrapResult(data: unknown): unknown {
  const root = asRecord(data)
  const result = root.result ?? root.data ?? data
  const resultRecord = asRecord(result)

  if (Array.isArray(resultRecord.records)) {
    return resultRecord.records
  }

  if (Array.isArray(resultRecord.list)) {
    return resultRecord.list
  }

  return result
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  const record = asRecord(value)

  if (Array.isArray(record.records)) {
    return record.records
  }

  if (Array.isArray(record.list)) {
    return record.list
  }

  if (Array.isArray(record.rows)) {
    return record.rows
  }

  return []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function emptyScores(): ProviderScoreResult {
  return {
    summary: buildScoreSummary(),
    semesters: [],
  }
}

const whggvcCourseConnector: CourseConnector = {
  async fetchByCredentials(input): Promise<CourseFetchResult> {
    const config = getConfig(input.providerConfig)
    const client = createWhggvcClient(config)
    const session = await login(client, config, input.username, input.password)
    const [schedule, profile] = await Promise.all([
      fetchSchedule(client, config, input.semesterId),
      fetchProfile(client, config, session),
    ])
    const [score, exam] = await Promise.all([
      fetchScores(client, config, {
        semesterId: schedule.selectedSemesterId,
        allSemesters: input.allSemesters,
      }).catch(() => emptyScores()),
      fetchExams(client, config, schedule.selectedSemesterId).catch(() => []),
    ])

    return {
      schedule,
      profile,
      features: {
        score,
        exam,
        profile,
      },
    }
  },
}

const whggvcScoreConnector: ScoreConnector = {
  async fetchByCredentials(
    input,
  ): Promise<FeatureFetchResult<ProviderScoreResult>> {
    const config = getConfig(input.providerConfig)
    const client = createWhggvcClient(config)

    await login(client, config, input.username, input.password)

    return {
      data: await fetchScores(client, config, input),
      termId: input.semesterId,
      meta: { source: 'server_session' },
    }
  },
}

const whggvcProfileConnector: ProfileConnector = {
  async fetchByCredentials(
    input,
  ): Promise<FeatureFetchResult<ProviderProfile>> {
    const config = getConfig(input.providerConfig)
    const client = createWhggvcClient(config)
    const session = await login(client, config, input.username, input.password)
    const data = await fetchProfile(client, config, session)

    return {
      data,
      profile: data,
      meta: { source: 'server_session' },
    }
  },
}

export const whggvcProvider: SchoolProvider = {
  id: 'whggvc',
  meta: {
    id: 'whggvc',
    name: '武汉光谷职业学院',
    shortName: '光谷职院',
    providerId: 'whggvc',
    loginMode: 'direct_password',
    eduSystemType: 'custom',
    status: 'beta',
    verifiedAt: '2026-06-15T00:00:00.000Z',
    capabilities: { course: true, score: true, exam: true, profile: true },
    credentialSave: {
      passwordVaultAllowed: true,
      autoSync: 'password_login_may_need_verification',
      scheduledSyncSupported: true,
      title: '支持保存登录信息',
      notice:
        '保存账号密码后可用于课表、成绩、考试与资料同步。该校接口存在请求签名机制，首次接入后仍需用真实账号完成验收。',
      consentLabel: '加密保存账号密码，用于同步智慧校园数据',
    },
    dataAccess: {
      course: ['server_session'],
      score: ['server_session'],
      exam: ['server_session'],
      profile: ['server_session'],
    },
    featureDisplay: {
      course: {
        title: '课表',
        kind: 'course_grid',
        itemFields: [
          { key: 'name', label: '课程', primary: true },
          { key: 'teacher', label: '教师' },
          { key: 'classroom', label: '教室', fallbackKeys: ['location'] },
          { key: 'weeks', label: '周次' },
        ],
        itemPath: 'courses',
        emptyText: '暂无课表数据',
      },
      score: {
        title: '成绩',
        kind: 'score_semesters',
        groupPath: 'semesters',
        itemPath: 'grades',
        itemFields: [
          { key: 'name', label: '课程' },
          { key: 'credit', label: '学分' },
          { key: 'score', label: '成绩', primary: true },
          { key: 'gpa', label: '绩点' },
        ],
        emptyText: '暂无成绩缓存',
      },
      exam: {
        title: '考试',
        kind: 'exam_list',
        itemFields: [
          { key: 'name', label: '课程', primary: true },
          { key: 'date', label: '日期' },
          { key: 'startTime', label: '开始' },
          { key: 'endTime', label: '结束' },
          { key: 'classroom', label: '考场' },
          { key: 'seatNumber', label: '座位' },
        ],
        emptyText: '暂无考试安排',
      },
      profile: {
        title: '个人资料',
        kind: 'profile_fields',
        summaryFields: [
          { key: 'name', label: '姓名' },
          {
            key: 'maskedStudentId',
            label: '学号',
            fallbackKeys: ['studentId'],
          },
          { key: 'gender', label: '性别' },
          { key: 'phone', label: '手机' },
        ],
        detailFields: [
          { key: 'studentId', label: '学号', editable: false },
          { key: 'gender', label: '性别', editable: true },
          { key: 'birthDate', label: '生日', editable: true },
          { key: 'phone', label: '手机', editable: true },
          { key: 'email', label: '邮箱', editable: true },
        ],
        editableFields: [
          { key: 'name', label: '姓名' },
          { key: 'gender', label: '性别' },
          { key: 'birthDate', label: '生日' },
          { key: 'phone', label: '手机' },
          { key: 'email', label: '邮箱' },
        ],
        emptyText: '暂无个人资料',
      },
    },
  },
  course: whggvcCourseConnector,
  score: whggvcScoreConnector,
  profile: whggvcProfileConnector,
}
