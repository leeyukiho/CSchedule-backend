import * as cheerio from 'cheerio'
import * as crypto from 'node:crypto'

import {
  CourseConnector,
  CourseFetchResult,
  FeatureFetchResult,
  ProviderCourse,
  ProviderProfile,
  ProviderScoreResult,
  ProfileConnector,
  ScoreConnector,
  SchoolProvider,
} from '../provider.types'
import { createProviderHttpClient } from './provider-http'
import {
  cleanText,
  firstValue,
  getTextFromHtml,
  maskStudentId,
  parseWeekRange,
} from './text-utils'

const DEFAULT_CONFIG = {
  baseUrl: 'https://jxgl.wtbu.edu.cn',
  loginPath: '/eams/login.action',
  homePath: '/eams/home.action',
  scheduleIndexPath: '/eams/courseTableForStd.action',
  scheduleTablePath: '/eams/courseTableForStd!courseTable.action',
}

function getConfig(providerConfig?: Record<string, unknown>) {
  return {
    ...DEFAULT_CONFIG,
    ...(providerConfig || {}),
  } as typeof DEFAULT_CONFIG
}

function parseProfile(homeHtml: unknown, fallbackStudentId: string) {
  const text = getTextFromHtml(homeHtml)
  const accountMatch = text.match(
    /([\u4e00-\u9fa5A-Za-z·]{2,30})\(([^)]+)\)\s+([^\s]+)/,
  )
  const name = accountMatch ? accountMatch[1] : ''
  const studentId = accountMatch ? accountMatch[2] : fallbackStudentId
  const role = accountMatch ? accountMatch[3] : '学生'

  return {
    name,
    studentId,
    role,
    maskedStudentId: maskStudentId(studentId),
    major: '',
    grade: '',
    level: '',
    className: '',
    gender: '',
    birthDate: '',
    politicalStatus: '',
    phone: '',
    email: '',
    nativePlace: '',
    enrollmentDate: '',
    studentStatus: '',
    dormitory: '',
    counselor: '',
    updatedAt: new Date().toISOString(),
  }
}

function normalizeLabel(value: unknown) {
  return cleanText(value).replace(/[：:]/g, '').replace(/\s+/g, '').trim()
}

function getPairValue(pairs: Record<string, string>, labels: string[]) {
  const entries = Object.entries(pairs || {})

  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label)
    const exact = entries.find(
      ([key]) => normalizeLabel(key) === normalizedLabel,
    )

    if (exact && exact[1]) {
      return exact[1]
    }
  }

  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label)
    const fuzzy = entries.find(([key]) => {
      const normalizedKey = normalizeLabel(key)
      return (
        normalizedKey.includes(normalizedLabel) ||
        normalizedLabel.includes(normalizedKey)
      )
    })

    if (fuzzy && fuzzy[1]) {
      return fuzzy[1]
    }
  }

  return ''
}

function parseKeyValuePairs(html: unknown) {
  const $ = cheerio.load(String(html || ''))
  const pairs: Record<string, string> = {}

  function addPair(label: unknown, value: unknown) {
    const key = normalizeLabel(label)
    const text = cleanText(value)

    if (!key || !text || key.length > 24) {
      return
    }

    pairs[key] = text
  }

  $('tr').each((index, row) => {
    const cells = $(row)
      .find('th,td')
      .map((cellIndex, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean)

    if (cells.length < 2) {
      return
    }

    for (let cellIndex = 0; cellIndex < cells.length - 1; cellIndex += 2) {
      addPair(cells[cellIndex], cells[cellIndex + 1])
    }
  })

  const text = getTextFromHtml(html)
  const labels = [
    '姓名',
    '学号',
    '性别',
    '出生年月',
    '出生日期',
    '政治面貌',
    '手机号',
    '联系电话',
    '邮箱',
    '电子邮箱',
    '籍贯',
    '生源地',
    '入学时间',
    '入学日期',
    '学籍状态',
    '学生状态',
    '宿舍信息',
    '宿舍',
    '辅导员',
    '班级',
    '行政班',
    '专业',
    '专业名称',
    '年级',
    '培养层次',
    '层次',
  ]

  for (const label of labels) {
    const pattern = new RegExp(
      `${label}\\s*[：:]\\s*([^：:]{1,80}?)(?=\\s+(?:${labels.join('|')})\\s*[：:]|$)`,
    )
    const match = text.match(pattern)

    if (match) {
      addPair(label, match[1])
    }
  }

  return pairs
}

function mergeProfile(
  baseProfile: ProviderProfile,
  detailHtml: unknown,
  fallbackStudentId: string,
) {
  const pairs = parseKeyValuePairs(detailHtml)
  const studentId =
    firstValue(
      getPairValue(pairs, ['学号', '学籍号']),
      baseProfile.studentId,
      fallbackStudentId,
    ) || fallbackStudentId

  return {
    ...baseProfile,
    name: firstValue(getPairValue(pairs, ['姓名']), baseProfile.name) as string,
    studentId: String(studentId),
    role: firstValue(baseProfile.role, '学生') as string,
    maskedStudentId: maskStudentId(studentId),
    major: firstValue(
      getPairValue(pairs, ['专业名称', '专业']),
      baseProfile.major,
    ) as string,
    grade: firstValue(
      getPairValue(pairs, ['年级']),
      baseProfile.grade,
    ) as string,
    level: firstValue(
      getPairValue(pairs, ['培养层次', '层次']),
      baseProfile.level,
    ) as string,
    className: firstValue(
      getPairValue(pairs, ['行政班', '班级']),
      baseProfile.className,
    ) as string,
    gender: firstValue(
      getPairValue(pairs, ['性别']),
      baseProfile.gender,
    ) as string,
    birthDate: firstValue(
      getPairValue(pairs, ['出生日期', '出生年月']),
      baseProfile.birthDate,
    ) as string,
    politicalStatus: firstValue(
      getPairValue(pairs, ['政治面貌']),
      baseProfile.politicalStatus,
    ) as string,
    phone: firstValue(
      getPairValue(pairs, ['手机号', '联系电话', '电话']),
      baseProfile.phone,
    ) as string,
    email: firstValue(
      getPairValue(pairs, ['电子邮箱', '邮箱']),
      baseProfile.email,
    ) as string,
    nativePlace: firstValue(
      getPairValue(pairs, ['籍贯', '生源地']),
      baseProfile.nativePlace,
    ) as string,
    enrollmentDate: firstValue(
      getPairValue(pairs, ['入学日期', '入学时间']),
      baseProfile.enrollmentDate,
    ) as string,
    studentStatus: firstValue(
      getPairValue(pairs, ['学籍状态', '学生状态']),
      baseProfile.studentStatus,
    ) as string,
    dormitory: firstValue(
      getPairValue(pairs, ['宿舍信息', '宿舍']),
      baseProfile.dormitory,
    ) as string,
    counselor: firstValue(
      getPairValue(pairs, ['辅导员']),
      baseProfile.counselor,
    ) as string,
    updatedAt: new Date().toISOString(),
  }
}

function extractHrefFromOnclick(onclick: unknown) {
  const text = String(onclick || '')
  const match =
    text.match(/(?:location\.href|open|href|url)\s*\(?\s*['"]([^'"]+)['"]/i) ||
    text.match(/['"](\/eams\/[^'"]+)['"]/i)

  return match ? match[1] : ''
}

function normalizeEduHref(href: unknown, baseUrl = DEFAULT_CONFIG.baseUrl) {
  const value = String(href || '').trim()

  if (!value || /^javascript:/i.test(value) || value === '#') {
    return ''
  }

  try {
    const url = new URL(value, baseUrl)

    if (url.origin !== baseUrl) {
      return ''
    }

    return `${url.pathname}${url.search}`
  } catch {
    return ''
  }
}

function findEduLinksByKeywords(
  html: unknown,
  keywords: string[],
  baseUrl: string,
) {
  const source = String(html || '')
  const $ = cheerio.load(source)
  const candidates: string[] = []

  $('a,area').each((index, element) => {
    const current = $(element)
    const text = cleanText(
      [current.text(), current.attr('title'), current.attr('href')].join(' '),
    )
    const onclick = current.attr('onclick') || ''
    const content = `${text} ${onclick}`
    const href =
      normalizeEduHref(current.attr('href'), baseUrl) ||
      normalizeEduHref(extractHrefFromOnclick(onclick), baseUrl)

    if (keywords.some((keyword) => content.includes(keyword)) && href) {
      candidates.push(href)
    }
  })

  for (const keyword of keywords) {
    const pattern = new RegExp(`.{0,160}${keyword}.{0,160}`, 'g')
    const snippets = source.match(pattern) || []

    for (const snippet of snippets) {
      const matches = snippet.match(/\/eams\/[^'"<>\s)]+/g) || []
      candidates.push(
        ...matches
          .map((href) => normalizeEduHref(href, baseUrl))
          .filter(Boolean),
      )
    }
  }

  return [...new Set(candidates)]
}

function getCurrentSemesterId(indexHtml: unknown) {
  const html = String(indexHtml || '')
  const $ = cheerio.load(html)
  const selectedOption = $('select[name="semester.id"] option[selected]')
    .first()
    .attr('value')
  const inputValue = $('input[name="semester.id"]').first().attr('value')
  const inputMatch =
    html.match(/name=["']semester\.id["'][^>]*value=["']([^"']*)["']/i) ||
    html.match(/value=["']([^"']*)["'][^>]*name=["']semester\.id["']/i)

  return selectedOption || inputValue || (inputMatch ? inputMatch[1] : '')
}

function parseSemesters(indexHtml: unknown) {
  const $ = cheerio.load(String(indexHtml || ''))
  const semesters: Array<{
    id: string
    title: string
    label: string
    selected: boolean
  }> = []

  $('select[name="semester.id"] option').each((index, option) => {
    const current = $(option)
    const id = String(current.attr('value') || '').trim()
    const label = cleanText(current.text())

    if (!id && !label) {
      return
    }

    semesters.push({
      id,
      title: label || '未命名学期',
      label: label || '未命名学期',
      selected: Boolean(current.attr('selected')),
    })
  })

  return semesters
}

function parseJsStringLiteral(value: unknown) {
  const text = String(value || '').trim()

  if (!text || text === 'null') {
    return ''
  }

  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as string
    } catch {
      return text.slice(1, -1)
    }
  }

  if (text.startsWith("'")) {
    return text.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  }

  return ''
}

function splitJsArguments(argsText: string) {
  const args: string[] = []
  let current = ''
  let quote = ''
  let depth = 0
  let escaped = false

  for (const char of argsText) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      current += char
      escaped = true
      continue
    }

    if (quote) {
      current += char
      if (char === quote) {
        quote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      current += char
      quote = char
      continue
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      current += char
      continue
    }

    if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      current += char
      continue
    }

    if (char === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) {
    args.push(current.trim())
  }

  return args
}

function extractTeacherNames(html: string, activityPosition: number) {
  const prefix = html.slice(
    Math.max(0, activityPosition - 1800),
    activityPosition,
  )
  const matches = [
    ...prefix.matchAll(/var\s+actTeachers\s*=\s*\[([\s\S]*?)\];/g),
  ]
  const latest = matches[matches.length - 1]

  if (!latest) {
    return ''
  }

  return [...latest[1].matchAll(/name\s*:\s*"((?:\\.|[^"\\])*)"/g)]
    .map((match) => parseJsStringLiteral(`"${match[1]}"`))
    .filter(Boolean)
    .join(',')
}

function getCourseName(rawName: unknown) {
  return String(rawName || '')
    .replace(/\([0-9A-Za-z.]+\)$/, '')
    .trim()
}

function takeTrailingParenthesized(text: string) {
  const source = String(text || '').trim()
  const match = source.match(/\s*\(([^()]*)\)\s*$/)

  if (!match) {
    return { rest: source, value: '' }
  }

  return {
    rest: source.slice(0, match.index).trim(),
    value: match[1].trim(),
  }
}

function parseCourseInfoText(rawText: unknown) {
  let rest = String(rawText || '')
    .trim()
    .replace(/^\{|\}$/g, '')
  const info = {
    name: getCourseName(rest),
    teacher: '',
    location: '',
    weeks: [] as number[],
  }
  const weekLocation = takeTrailingParenthesized(rest)

  if (weekLocation.value && /^[0-9,\-\s周]+[,，]/.test(weekLocation.value)) {
    const parts = weekLocation.value.split(/[,，]/)
    info.weeks = parseWeekRange(parts.shift())
    info.location = parts.join('，').trim()
    rest = weekLocation.rest
  }

  const teacher = takeTrailingParenthesized(rest)

  if (teacher.value && !/^[0-9A-Za-z.]+$/.test(teacher.value)) {
    info.teacher = teacher.value
    rest = teacher.rest
  }

  info.name = getCourseName(rest)

  return info
}

function getWeekNumbers(
  validWeeks: string,
  from: number,
  startWeek: number,
  endWeek: number,
) {
  if (!validWeeks) {
    return []
  }

  let rotatedWeeks = validWeeks

  if (from > 1) {
    const before = validWeeks.substring(0, from - 1)
    rotatedWeeks = validWeeks.substring(from - 1)

    if (before.includes('1')) {
      rotatedWeeks += before
    }

    while (rotatedWeeks.length < validWeeks.length) {
      rotatedWeeks += '0'
    }
  }

  const weeks: number[] = []

  for (let week = startWeek; week <= endWeek; week += 1) {
    if (rotatedWeeks.charAt(week - 1) === '1') {
      weeks.push(week)
    }
  }

  return weeks
}

function splitContinuousSections(sections: number[]) {
  const sorted = [...new Set(sections)].sort((a, b) => a - b)
  const groups: number[][] = []

  for (const section of sorted) {
    const latest = groups[groups.length - 1]

    if (!latest || latest[latest.length - 1] + 1 !== section) {
      groups.push([section])
    } else {
      latest.push(section)
    }
  }

  return groups
}

function parseSchedule(scheduleHtml: unknown) {
  const html = String(scheduleHtml || '')
  const $ = cheerio.load(html)
  const term =
    $('h3[align="center"]').first().text().trim() ||
    $('h3').first().text().trim() ||
    '本学期'
  const marshalMatch = html.match(
    /\.marshalTable\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)/,
  )
  const from = marshalMatch ? Number(marshalMatch[1]) : 1
  const startWeek = marshalMatch ? Number(marshalMatch[2]) : 1
  const endWeek = marshalMatch ? Number(marshalMatch[3]) : 25
  const unitCountMatch = html.match(/var\s+unitCount\s*=\s*(\d+)/)
  const unitCount = unitCountMatch ? Number(unitCountMatch[1]) : 13
  const courses: ProviderCourse[] = []
  const activityRegex =
    /activity\s*=\s*new\s+TaskActivity\(([\s\S]*?)\);\s*((?:\s*index\s*=\s*\d+\s*\*\s*unitCount\s*\+\s*\d+\s*;\s*table\d+\.activities\[index\]\[table\d+\.activities\[index\]\.length\]\s*=\s*activity\s*;\s*)+)/g
  let match: RegExpExecArray | null

  while ((match = activityRegex.exec(html)) !== null) {
    const args = splitJsArguments(match[1])
    const rawCourseName = parseJsStringLiteral(args[3])
    const parsedCourseInfo = parseCourseInfoText(rawCourseName)
    const name = parsedCourseInfo.name || getCourseName(rawCourseName)
    const roomName = parseJsStringLiteral(args[5]) || parsedCourseInfo.location
    const validWeeks = parseJsStringLiteral(args[6])
    const teacherName =
      extractTeacherNames(html, match.index) ||
      parseJsStringLiteral(args[1]) ||
      parsedCourseInfo.teacher
    const weeks = getWeekNumbers(validWeeks, from, startWeek, endWeek)
    const activeWeeks = weeks.length > 0 ? weeks : parsedCourseInfo.weeks
    const slotsByDay = new Map<number, number[]>()

    for (const slot of match[2].matchAll(
      /index\s*=\s*(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)/g,
    )) {
      const weekday = Number(slot[1]) + 1
      const section = Number(slot[2]) + 1
      const sections = slotsByDay.get(weekday) || []
      sections.push(section)
      slotsByDay.set(weekday, sections)
    }

    for (const [weekday, sections] of slotsByDay.entries()) {
      for (const sectionGroup of splitContinuousSections(sections)) {
        courses.push({
          id: `${courses.length + 1}`,
          name,
          teacher: teacherName,
          location: roomName,
          classroom: roomName,
          weekday,
          sections: sectionGroup,
          startSection: sectionGroup[0],
          endSection: sectionGroup[sectionGroup.length - 1],
          weeks: activeWeeks,
        })
      }
    }
  }

  return {
    term,
    courses: courses.sort((a, b) => {
      if (a.weekday !== b.weekday) {
        return a.weekday - b.weekday
      }

      return (a.sections?.[0] || 0) - (b.sections?.[0] || 0)
    }),
  }
}

async function loginToEduSystem(
  client: ReturnType<typeof createProviderHttpClient>,
  config: ReturnType<typeof getConfig>,
  username: string,
  password: string,
) {
  const loginPage = await client.get(config.homePath)
  const loginHtml = String(loginPage.data || '')
  const saltMatch = loginHtml.match(
    /CryptoJS\.SHA1\('([^']*)'\s*\+\s*form\['password'\]\.value\)/,
  )

  if (!saltMatch) {
    throw new Error('无法读取教务系统登录参数')
  }

  const hashedPassword = crypto
    .createHash('sha1')
    .update(`${saltMatch[1]}${password}`, 'utf8')
    .digest('hex')
  const loginPayload = new URLSearchParams({
    username: username.trim(),
    password: hashedPassword,
    encodedPassword: '',
    session_locale: 'zh_CN',
  })
  const loginResponse = await client.post(
    config.loginPath,
    loginPayload.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    },
  )
  const loginBody = String(loginResponse.data || '')

  if (
    loginBody.includes('密码错误') ||
    loginBody.includes('登录失败') ||
    (loginBody.includes('用户名') && loginBody.includes('密码'))
  ) {
    throw new Error('学号或密码错误')
  }

  const homePage = await client.get(config.homePath)
  const homeHtml = String(homePage.data || '')

  if (homeHtml.includes('loginForm') || homeHtml.includes('请输入用户名')) {
    throw new Error('学号或密码错误')
  }

  return homeHtml
}

async function fetchEduPath(
  client: ReturnType<typeof createProviderHttpClient>,
  path: unknown,
  baseUrl: string,
) {
  const normalizedPath = normalizeEduHref(path, baseUrl)

  if (!normalizedPath) {
    return ''
  }

  const response = await client.get(normalizedPath, {
    validateStatus: (status) => status >= 200 && status < 400,
  })
  const html = String(response.data || '')

  if (!html || html.includes('loginForm') || html.includes('请输入用户名')) {
    return ''
  }

  return html
}

async function fetchEduPageByKeywords(
  client: ReturnType<typeof createProviderHttpClient>,
  homeHtml: unknown,
  keywords: string[],
  fallbackPaths: string[],
  baseUrl: string,
) {
  const paths = [
    ...findEduLinksByKeywords(homeHtml, keywords, baseUrl),
    ...fallbackPaths,
  ]
    .map((path) => normalizeEduHref(path, baseUrl))
    .filter(Boolean)
  const uniquePaths = [...new Set(paths)]

  for (const path of uniquePaths) {
    try {
      const html = await fetchEduPath(client, path, baseUrl)

      if (html) {
        return html
      }
    } catch (error) {
      console.warn(
        `fetch edu page failed: ${path}`,
        error instanceof Error ? error.message : '',
      )
    }
  }

  return ''
}

async function fetchProfile(
  client: ReturnType<typeof createProviderHttpClient>,
  config: ReturnType<typeof getConfig>,
  homeHtml: unknown,
  studentId: string,
) {
  const fallbackProfile = parseProfile(homeHtml, studentId)
  const profileHtml = await fetchEduPageByKeywords(
    client,
    homeHtml,
    ['学籍信息', '个人信息', '基本信息'],
    [
      '/eams/stdDetail.action',
      '/eams/stdDetail!info.action',
      '/eams/home.action',
    ],
    config.baseUrl,
  )

  return profileHtml
    ? mergeProfile(fallbackProfile, profileHtml, studentId)
    : fallbackProfile
}

function getStrictCellByLabels(row: Record<string, unknown>, labels: string[]) {
  const entries = Object.entries(row || {})

  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label)
    const exact = entries.find(
      ([key]) => normalizeLabel(key) === normalizedLabel,
    )

    if (exact && exact[1]) {
      return cleanText(exact[1])
    }
  }

  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label)
    const fuzzy = entries.find(([key]) => {
      const normalizedKey = normalizeLabel(key)

      if (normalizedLabel === '课程' && normalizedKey !== '课程') {
        return false
      }

      return (
        normalizedKey.includes(normalizedLabel) ||
        normalizedLabel.includes(normalizedKey)
      )
    })

    if (fuzzy && fuzzy[1]) {
      return cleanText(fuzzy[1])
    }
  }

  return ''
}

function getGradeCellByLabels(
  row: Record<string, unknown>,
  labels: string[],
  options: { exclude?: string } = {},
) {
  const entries = Object.entries(row || {})
  const negativePattern = options.exclude ? new RegExp(options.exclude) : null

  function canUseKey(key: string) {
    const normalizedKey = normalizeLabel(key)
    return !negativePattern || !negativePattern.test(normalizedKey)
  }

  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label)
    const exact = entries.find(
      ([key]) => normalizeLabel(key) === normalizedLabel,
    )

    if (exact && exact[1] && canUseKey(exact[0])) {
      return cleanText(exact[1])
    }
  }

  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label)
    const fuzzy = entries.find(([key]) => {
      const normalizedKey = normalizeLabel(key)
      return (
        canUseKey(key) &&
        normalizedKey.includes(normalizedLabel) &&
        !normalizedLabel.includes(normalizedKey)
      )
    })

    if (fuzzy && fuzzy[1]) {
      return cleanText(fuzzy[1])
    }
  }

  return ''
}

function isCourseCategoryText(value: unknown) {
  return /^(必修课?|选修课?|限选课?|任选课?|公选课?|通识课?|实践课?|专业必修|专业选修|公共必修)$/u.test(
    cleanText(value),
  )
}

function isBadCourseName(value: unknown) {
  const text = cleanText(value)

  return (
    !text ||
    isCourseCategoryText(text) ||
    /^(课程名称|课程类别|课程性质|课程属性|成绩|学分|绩点)$/u.test(text) ||
    /^\d+(?:\.\d+)?$/.test(text)
  )
}

function getGradeCourseName(row: Record<string, unknown>) {
  const entries = Object.entries(row || {})
  const exactLabels = [
    '课程名称',
    '课程名',
    '科目名称',
    '考试课程',
    '教学班名称',
  ]

  for (const label of exactLabels) {
    const normalizedLabel = normalizeLabel(label)
    const exact = entries.find(
      ([key]) => normalizeLabel(key) === normalizedLabel,
    )

    if (exact && !isBadCourseName(exact[1])) {
      return cleanText(exact[1])
    }
  }

  const nameLike = entries.find(([key, value]) => {
    const normalizedKey = normalizeLabel(key)

    return (
      /名称|课程名|科目/.test(normalizedKey) &&
      !/类别|性质|属性|序号|代码|编号|学分|成绩|绩点/.test(normalizedKey) &&
      !isBadCourseName(value)
    )
  })

  if (nameLike) {
    return cleanText(nameLike[1])
  }

  const cells = Array.isArray(row.__cells) ? (row.__cells as string[]) : []
  const fallback = cells
    .filter((cell) => !isBadCourseName(cell))
    .filter(
      (cell) => !/20\d{2}\s*-\s*20\d{2}|第?[一二12]学期|已修|通过/.test(cell),
    )
    .sort((a, b) => b.length - a.length)[0]

  return fallback || ''
}

function extractTableRows(html: unknown) {
  const $ = cheerio.load(String(html || ''))
  const rows: Array<Record<string, unknown>> = []

  $('table').each((tableIndex, table) => {
    let headers: string[] = []

    $(table)
      .find('tr')
      .each((rowIndex, row) => {
        const cells = $(row)
          .find('th,td')
          .map((cellIndex, cell) => cleanText($(cell).text()))
          .get()
        const nonEmptyCells = cells.filter(Boolean)

        if (nonEmptyCells.length === 0) {
          return
        }

        const hasHeaderCell = $(row).find('th').length > 0
        const looksLikeHeader = nonEmptyCells.some((cell) =>
          /课程|成绩|学分|绩点|考试|时间|地点|座位|学期/.test(cell),
        )

        if ((hasHeaderCell || headers.length === 0) && looksLikeHeader) {
          headers = cells.map((cell, index) => cell || `列${index + 1}`)
          return
        }

        if (headers.length === 0 || nonEmptyCells.length < 2) {
          return
        }

        const data: Record<string, unknown> = {}

        cells.forEach((cell, index) => {
          data[headers[index] || `列${index + 1}`] = cell
        })
        Object.defineProperty(data, '__cells', {
          value: cells,
          enumerable: false,
        })
        rows.push(data)
      })
  })

  return rows
}

function toNumber(value: unknown) {
  const match = String(value || '').match(/\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : 0
}

function getNumericScore(value: unknown) {
  const text = String(value || '').trim()

  if (/^(优秀|优)$/u.test(text)) {
    return 95
  }

  if (/^良好?$/u.test(text)) {
    return 85
  }

  if (/^中等?$/u.test(text)) {
    return 75
  }

  if (/^及格$/u.test(text)) {
    return 60
  }

  if (/^(不及格|缺考|缓考|作弊)$/u.test(text)) {
    return 0
  }

  return toNumber(text)
}

function formatNumber(value: number, digits = 2) {
  if (!Number.isFinite(value) || value <= 0) {
    return '--'
  }

  return Number(value.toFixed(digits)).toString()
}

function calculateGpa(score: unknown, sourceGpa: unknown) {
  const numericScore = getNumericScore(score)

  if (numericScore < 60) {
    return { value: 0, text: '--' }
  }

  const existingGpa = toNumber(sourceGpa)
  const gpa = existingGpa > 0 ? existingGpa : (numericScore - 50) / 10

  return { value: gpa, text: formatNumber(gpa, 1) }
}

function extractGradeRecords(gradesHtml: unknown, defaultTerm = '') {
  const rows = extractTableRows(gradesHtml)
  const records: Array<{
    term: string
    name: string
    credit: string
    score: string
    gpa: string
  }> = []

  for (const row of rows) {
    const name = getGradeCourseName(row)
    const score = getGradeCellByLabels(
      row,
      ['最终成绩', '总评成绩', '总评', '成绩'],
      {
        exclude: '绩点|学分',
      },
    )

    if (!name || !score || isBadCourseName(name)) {
      continue
    }

    records.push({
      term:
        getStrictCellByLabels(row, ['学年学期', '开课学期', '学期', '学年']) ||
        defaultTerm ||
        '未分组学期',
      name,
      credit: getGradeCellByLabels(row, ['学分', '课程学分'], {
        exclude: '成绩|绩点',
      }),
      score,
      gpa: getGradeCellByLabels(row, ['绩点', '课程绩点'], {
        exclude: '成绩|学分',
      }),
    })
  }

  return records
}

function buildGradesResult(
  records: ReturnType<typeof extractGradeRecords>,
): ProviderScoreResult {
  const semesters = new Map<
    string,
    {
      id: string
      title: string
      creditValue: number
      scoreValue: number
      scoreCredit: number
      gpaValue: number
      gpaCredit: number
      grades: ProviderScoreResult['semesters'][number]['grades']
    }
  >()
  const seen = new Set<string>()
  const groupedRecordKeys = new Set(
    records
      .filter((record) => record.term && record.term !== '未分组学期')
      .map((record) =>
        [record.name, record.credit, record.score, record.gpa].join('|'),
      ),
  )
  let totalCredit = 0
  let weightedScore = 0
  let weightedGpa = 0
  let scoreCredit = 0
  let gpaCredit = 0

  for (const record of records) {
    const basicKey = [
      record.name,
      record.credit,
      record.score,
      record.gpa,
    ].join('|')

    if (
      (!record.term || record.term === '未分组学期') &&
      groupedRecordKeys.has(basicKey)
    ) {
      continue
    }

    const uniqueKey = [
      record.term,
      record.name,
      record.credit,
      record.score,
      record.gpa,
    ].join('|')

    if (seen.has(uniqueKey)) {
      continue
    }

    seen.add(uniqueKey)

    const term = record.term || '未分组学期'
    const credit = toNumber(record.credit)
    const numericScore = getNumericScore(record.score)
    const scoreLow = numericScore > 0 && numericScore < 60
    const gpa = calculateGpa(record.score, record.gpa)
    const grade = {
      name: record.name,
      credit: record.credit || '--',
      score: record.score,
      scoreLow,
      gpa: gpa.text,
    }

    if (!semesters.has(term)) {
      semesters.set(term, {
        id: `semester-${semesters.size + 1}`,
        title: term,
        creditValue: 0,
        scoreValue: 0,
        scoreCredit: 0,
        gpaValue: 0,
        gpaCredit: 0,
        grades: [],
      })
    }

    const semester = semesters.get(term)

    if (!semester) {
      continue
    }

    semester.grades.push(grade)
    semester.creditValue += credit

    if (credit > 0) {
      totalCredit += credit

      if (numericScore > 0) {
        semester.scoreValue += numericScore * credit
        semester.scoreCredit += credit
        weightedScore += numericScore * credit
        scoreCredit += credit
      }

      if (gpa.value > 0) {
        semester.gpaValue += gpa.value * credit
        semester.gpaCredit += credit
        weightedGpa += gpa.value * credit
        gpaCredit += credit
      }
    }
  }

  return {
    summary: [
      { label: '总学分', value: formatNumber(totalCredit, 1) },
      { label: '平均分', value: formatNumber(weightedScore / scoreCredit, 2) },
      { label: '绩点', value: formatNumber(weightedGpa / gpaCredit, 2) },
    ],
    semesters: [...semesters.values()].map((semester, index) => ({
      id: semester.id,
      title: semester.title,
      credit: formatNumber(semester.creditValue, 1),
      average: formatNumber(semester.scoreValue / semester.scoreCredit, 2),
      gpa: formatNumber(semester.gpaValue / semester.gpaCredit, 2),
      expanded: index === 0,
      grades: semester.grades,
    })),
  }
}

function mergeGradePages(pages: Array<{ html: unknown; term: string }>) {
  return buildGradesResult(
    pages.flatMap((page) => extractGradeRecords(page.html, page.term)),
  )
}

function parseGradeSemesters(gradesHtml: unknown) {
  const html = String(gradesHtml || '')
  const $ = cheerio.load(html)
  const semesters: Array<{ id: string; label: string }> = []

  function addSemester(id: unknown, label?: unknown) {
    const semesterId = String(id || '').trim()

    if (
      !semesterId ||
      semesters.some((semester) => semester.id === semesterId)
    ) {
      return
    }

    semesters.push({
      id: semesterId,
      label: cleanText(label) || `学期 ${semesterId}`,
    })
  }

  $('select[name="semesterId"] option, select[name="semester.id"] option').each(
    (index, option) => {
      const current = $(option)
      addSemester(current.attr('value'), current.text())
    },
  )

  $('a[href], area[href]').each((index, element) => {
    const current = $(element)
    const match = String(current.attr('href') || '').match(
      /[?&]semesterId=([^&#]+)/,
    )

    if (match) {
      addSemester(
        decodeURIComponent(match[1]),
        current.text() || current.attr('title'),
      )
    }
  })

  $('[onclick]').each((index, element) => {
    const current = $(element)
    const onclick = String(current.attr('onclick') || '')
    const match =
      onclick.match(/semesterId\s*[=:]\s*['"]?(\d+)/) ||
      onclick.match(/[?&]semesterId=(\d+)/)

    if (match) {
      addSemester(match[1], current.text() || current.attr('title'))
    }
  })

  for (const match of html.matchAll(/semesterId\s*[=:]\s*['"]?(\d+)/g)) {
    const start = Math.max(0, (match.index || 0) - 120)
    const end = Math.min(html.length, (match.index || 0) + 160)
    const label = getTextFromHtml(html.slice(start, end)).match(
      /20\d{2}\s*-\s*20\d{2}\s*(?:学年)?\s*(?:第?[一二12]学期|学期[一二12])?/,
    )

    addSemester(match[1], label ? label[0] : '')
  }

  return semesters
}

function emptyGrades(): ProviderScoreResult {
  return {
    summary: [
      { label: '总学分', value: '--' },
      { label: '平均分', value: '--' },
      { label: '绩点', value: '--' },
    ],
    semesters: [],
  }
}

async function fetchGrades(
  client: ReturnType<typeof createProviderHttpClient>,
  config: ReturnType<typeof getConfig>,
  homeHtml: unknown,
) {
  const gradesHtml = await fetchEduPageByKeywords(
    client,
    homeHtml,
    ['我的成绩', '成绩查询', '成绩'],
    [
      '/eams/teach/grade/course/person.action',
      '/eams/teach/grade/course/person!search.action?semesterId=&projectType=',
      '/eams/teach/grade/course/person!historyCourseGrade.action?projectType=MAJOR',
    ],
    config.baseUrl,
  )

  if (!gradesHtml) {
    return emptyGrades()
  }

  const pages = [{ html: gradesHtml, term: '' }]
  const semesters = parseGradeSemesters(gradesHtml)
  const paths = [
    '/eams/teach/grade/course/person!search.action?semesterId=&projectType=',
    '/eams/teach/grade/course/person!historyCourseGrade.action?projectType=MAJOR',
    ...semesters.flatMap((semester) => [
      `/eams/teach/grade/course/person!search.action?semesterId=${encodeURIComponent(semester.id)}&projectType=`,
      `/eams/teach/grade/course/person!search.action?semesterId=${encodeURIComponent(semester.id)}&projectType=MAJOR`,
    ]),
  ]
  const seenPaths = new Set<string>()

  for (const path of paths) {
    if (seenPaths.has(path)) {
      continue
    }

    seenPaths.add(path)

    try {
      const html = await fetchEduPath(client, path, config.baseUrl)

      if (!html) {
        continue
      }

      const semesterId = (path.match(/[?&]semesterId=([^&#]*)/) || [])[1] || ''
      const semester = semesters.find(
        (item) => item.id === decodeURIComponent(semesterId),
      )
      pages.push({
        html,
        term: semester ? semester.label : '',
      })
    } catch (error) {
      console.warn(
        `fetch grades page failed: ${path}`,
        error instanceof Error ? error.message : '',
      )
    }
  }

  const result = mergeGradePages(pages)
  return result.semesters.length > 0 ? result : emptyGrades()
}

async function fetchScheduleWithClient(
  client: ReturnType<typeof createProviderHttpClient>,
  config: ReturnType<typeof getConfig>,
  input: { semesterId?: string },
) {
  const indexResponse = await client.get(config.scheduleIndexPath)
  const indexHtml = String(indexResponse.data || '')
  const idsMatch = indexHtml.match(
    /bg\.form\.addInput\(form,\s*"ids",\s*"([^"]+)"\)/,
  )

  if (!idsMatch) {
    throw new Error('无法定位学生课表参数')
  }

  const semesterMatch = indexHtml.match(/name="semester\.id"\s+value="([^"]*)"/)
  let semesters = parseSemesters(indexHtml)
  const currentSemesterId =
    getCurrentSemesterId(indexHtml) || (semesterMatch ? semesterMatch[1] : '')
  const semesterId = String(input.semesterId || '').trim() || currentSemesterId
  const tablePayload = new URLSearchParams({
    ids: idsMatch[1],
    'semester.id': semesterId,
    'setting.kind': 'std',
    startWeek: '',
  })
  const response = await client.post(
    config.scheduleTablePath,
    tablePayload.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  )
  const parsedSchedule = parseSchedule(response.data)

  if (
    (semesterId || parsedSchedule.term) &&
    !semesters.some((semester) => semester.id === semesterId)
  ) {
    semesters = [
      {
        id: semesterId || '',
        title: parsedSchedule.term || '当前学期',
        label: parsedSchedule.term || '当前学期',
        selected: true,
      },
      ...semesters,
    ]
  }

  return {
    ...parsedSchedule,
    semesters: semesters.map((semester) => ({
      ...semester,
      selected: semester.id === semesterId,
    })),
    selectedSemesterId: semesterId,
  }
}

const wtbuCourseConnector: CourseConnector = {
  async fetchByCredentials(input): Promise<CourseFetchResult> {
    const config = getConfig(input.providerConfig)
    const client = createProviderHttpClient({
      baseUrl: config.baseUrl,
      timeout: 12000,
      rejectUnauthorized: false,
    })
    const homeHtml = await loginToEduSystem(
      client,
      config,
      input.username,
      input.password,
    )
    const [schedule, profile, score] = await Promise.all([
      fetchScheduleWithClient(client, config, { semesterId: input.semesterId }),
      fetchProfile(client, config, homeHtml, input.username),
      fetchGrades(client, config, homeHtml),
    ])

    return {
      schedule,
      profile,
      features: {
        score,
        profile,
      },
    }
  },
}

const wtbuScoreConnector: ScoreConnector = {
  async fetchByCredentials(
    input,
  ): Promise<FeatureFetchResult<ProviderScoreResult>> {
    const config = getConfig(input.providerConfig)
    const client = createProviderHttpClient({
      baseUrl: config.baseUrl,
      timeout: 12000,
      rejectUnauthorized: false,
    })
    const homeHtml = await loginToEduSystem(
      client,
      config,
      input.username,
      input.password,
    )
    const data = await fetchGrades(client, config, homeHtml)

    return {
      data,
      meta: { source: 'server_session' },
    }
  },
}

const wtbuProfileConnector: ProfileConnector = {
  async fetchByCredentials(
    input,
  ): Promise<FeatureFetchResult<ProviderProfile>> {
    const config = getConfig(input.providerConfig)
    const client = createProviderHttpClient({
      baseUrl: config.baseUrl,
      timeout: 12000,
      rejectUnauthorized: false,
    })
    const homeHtml = await loginToEduSystem(
      client,
      config,
      input.username,
      input.password,
    )
    const data = await fetchProfile(client, config, homeHtml, input.username)

    return {
      data,
      profile: data,
      meta: { source: 'server_session' },
    }
  },
}

export const wtbuProvider: SchoolProvider = {
  id: 'wtbu',
  meta: {
    id: 'wtbu',
    name: '武汉工商学院',
    shortName: '武工商',
    providerId: 'wtbu',
    loginMode: 'direct_password',
    eduSystemType: 'eams',
    status: 'enabled',
    verifiedAt: '2026-06-12T00:00:00.000Z',
    capabilities: { course: true, score: true, exam: true, profile: true },
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
        summaryFields: [
          { key: 'totalCredit', label: '总学分' },
          { key: 'average', label: '平均分' },
          { key: 'gpa', label: '绩点' },
        ],
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
      profile: {
        title: '个人资料',
        kind: 'profile_fields',
        summaryFields: [
          { key: 'name', label: '姓名' },
          { key: 'maskedStudentId', label: '学号', fallbackKeys: ['studentId'] },
          { key: 'major', label: '专业' },
          { key: 'className', label: '班级' },
          { key: 'level', label: '层次', fallbackKeys: ['grade'] },
        ],
        detailFields: [
          { key: 'studentId', label: '学号', editable: false },
          { key: 'grade', label: '年级', editable: true },
          { key: 'gender', label: '性别', editable: true },
          { key: 'phone', label: '手机号', editable: true },
          { key: 'email', label: '邮箱', editable: true },
          { key: 'nativePlace', label: '籍贯', editable: true },
          { key: 'enrollmentDate', label: '入学时间', editable: true },
          { key: 'studentStatus', label: '学籍状态', editable: true },
          { key: 'dormitory', label: '宿舍信息', editable: true },
          { key: 'counselor', label: '辅导员', editable: true },
        ],
        editableFields: [
          { key: 'name', label: '姓名' },
          { key: 'major', label: '专业' },
          { key: 'grade', label: '年级' },
          { key: 'level', label: '层次' },
          { key: 'className', label: '班级' },
          { key: 'gender', label: '性别' },
          { key: 'birthDate', label: '出生年月' },
          { key: 'politicalStatus', label: '政治面貌' },
          { key: 'phone', label: '手机号' },
          { key: 'email', label: '邮箱' },
          { key: 'nativePlace', label: '籍贯' },
          { key: 'enrollmentDate', label: '入学时间' },
          { key: 'studentStatus', label: '学籍状态' },
          { key: 'dormitory', label: '宿舍信息' },
          { key: 'counselor', label: '辅导员' },
        ],
        emptyText: '暂无个人资料',
      },
    },
  },
  course: wtbuCourseConnector,
  score: wtbuScoreConnector,
  profile: wtbuProfileConnector,
}
