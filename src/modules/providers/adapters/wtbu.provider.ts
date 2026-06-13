import * as cheerio from 'cheerio'
import * as crypto from 'node:crypto'

import {
  CourseConnector,
  CourseFetchResult,
  ProviderCourse,
  SchoolProvider,
} from '../provider.types'
import { createProviderHttpClient } from './provider-http'
import { cleanText, getTextFromHtml, maskStudentId, parseWeekRange } from './text-utils'

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
  const accountMatch = text.match(/([\u4e00-\u9fa5A-Za-z路]{2,30})\(([^)]+)\)\s+([^\s]+)/)
  const name = accountMatch ? accountMatch[1] : ''
  const studentId = accountMatch ? accountMatch[2] : fallbackStudentId

  return {
    name,
    studentId,
    maskedStudentId: maskStudentId(studentId),
  }
}

function getCurrentSemesterId(indexHtml: unknown) {
  const html = String(indexHtml || '')
  const $ = cheerio.load(html)
  const selectedOption = $('select[name="semester.id"] option[selected]').first().attr('value')
  const inputValue = $('input[name="semester.id"]').first().attr('value')
  const inputMatch =
    html.match(/name=["']semester\.id["'][^>]*value=["']([^"']*)["']/i) ||
    html.match(/value=["']([^"']*)["'][^>]*name=["']semester\.id["']/i)

  return selectedOption || inputValue || (inputMatch ? inputMatch[1] : '')
}

function parseSemesters(indexHtml: unknown) {
  const $ = cheerio.load(String(indexHtml || ''))
  const semesters: Array<{ id: string; title: string; label: string; selected: boolean }> = []

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
  const prefix = html.slice(Math.max(0, activityPosition - 1800), activityPosition)
  const matches = [...prefix.matchAll(/var\s+actTeachers\s*=\s*\[([\s\S]*?)\];/g)]
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
  let rest = String(rawText || '').trim().replace(/^\{|\}$/g, '')
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

function getWeekNumbers(validWeeks: string, from: number, startWeek: number, endWeek: number) {
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
  const term = $('h3[align="center"]').first().text().trim() || $('h3').first().text().trim() || '本学期'
  const marshalMatch = html.match(/\.marshalTable\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)/)
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

    for (const slot of match[2].matchAll(/index\s*=\s*(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)/g)) {
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

const wtbuCourseConnector: CourseConnector = {
  async fetchByCredentials(input): Promise<CourseFetchResult> {
    const config = getConfig(input.providerConfig)
    const client = createProviderHttpClient({
      baseUrl: config.baseUrl,
      timeout: 12000,
      rejectUnauthorized: false,
    })
    const loginPage = await client.get(config.homePath)
    const loginHtml = String(loginPage.data || '')
    const saltMatch = loginHtml.match(/CryptoJS\.SHA1\('([^']*)'\s*\+\s*form\['password'\]\.value\)/)

    if (!saltMatch) {
      throw new Error('无法读取教务系统登录参数')
    }

    const hashedPassword = crypto
      .createHash('sha1')
      .update(`${saltMatch[1]}${input.password}`, 'utf8')
      .digest('hex')

    const loginPayload = new URLSearchParams({
      username: input.username.trim(),
      password: hashedPassword,
      encodedPassword: '',
      session_locale: 'zh_CN',
    })

    const loginResponse = await client.post(config.loginPath, loginPayload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    })
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

    const indexResponse = await client.get(config.scheduleIndexPath)
    const indexHtml = String(indexResponse.data || '')
    const idsMatch = indexHtml.match(/bg\.form\.addInput\(form,\s*"ids",\s*"([^"]+)"\)/)

    if (!idsMatch) {
      throw new Error('无法定位学生课表参数')
    }

    const semesterMatch = indexHtml.match(/name="semester\.id"\s+value="([^"]*)"/)
    let semesters = parseSemesters(indexHtml)
    const currentSemesterId = getCurrentSemesterId(indexHtml) || (semesterMatch ? semesterMatch[1] : '')
    const semesterId = String(input.semesterId || '').trim() || currentSemesterId
    const tablePayload = new URLSearchParams({
      ids: idsMatch[1],
      'semester.id': semesterId,
      'setting.kind': 'std',
      startWeek: '',
    })

    const response = await client.post(config.scheduleTablePath, tablePayload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
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
      schedule: {
        ...parsedSchedule,
        semesters: semesters.map((semester) => ({
          ...semester,
          selected: semester.id === semesterId,
        })),
        selectedSemesterId: semesterId,
      },
      profile: parseProfile(homeHtml, input.username),
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
  },
  course: wtbuCourseConnector,
}

