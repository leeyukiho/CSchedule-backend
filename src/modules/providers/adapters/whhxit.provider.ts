import * as cheerio from 'cheerio'
import * as crypto from 'node:crypto'

import {
  CourseConnector,
  CourseFetchResult,
  ProviderCourse,
  SchoolProvider,
} from '../provider.types'
import { createProviderHttpClient } from './provider-http'
import { cleanText, firstValue, maskStudentId, parseSections, parseWeekRange } from './text-utils'

const DEFAULT_CONFIG = {
  baseUrl: 'https://jwgl.whhxit.edu.cn',
  loginPath: '/jwglxt/xtgl/login_slogin.html',
  publicKeyPath: '/jwglxt/xtgl/login_getPublicKey.html',
  logoutPath: '/jwglxt/xtgl/login_logoutAccount.html',
  homePath: '/jwglxt/xtgl/index_initMenu.html?jsdm=xs',
  scheduleIndexPath: '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151',
  scheduleDataPath: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151',
}

const XQM_LABELS: Record<string, string> = {
  '3': '第1学期',
  '12': '第2学期',
  '16': '第3学期',
}

function getConfig(providerConfig?: Record<string, unknown>) {
  return {
    ...DEFAULT_CONFIG,
    ...(providerConfig || {}),
  } as typeof DEFAULT_CONFIG
}

function extractInputValue(html: unknown, nameOrId: string) {
  const $ = cheerio.load(String(html || ''))
  const byName = $(`input[name="${nameOrId}"]`).first().attr('value')
  const byId = $(`input#${nameOrId}`).first().attr('value')

  return String(byName || byId || '').trim()
}

function base64ToBuffer(value: unknown) {
  let text = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/')

  while (text.length % 4 !== 0) {
    text += '='
  }

  return Buffer.from(text, 'base64')
}

function unsignedBase64UrlToBase64(value: unknown) {
  const buffer = base64ToBuffer(value)
  let start = 0

  while (start < buffer.length - 1 && buffer[start] === 0) {
    start += 1
  }

  return buffer
    .slice(start)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function createPublicKeyFromJwk(modulus: unknown, exponent: unknown) {
  return crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: unsignedBase64UrlToBase64(modulus),
      e: unsignedBase64UrlToBase64(exponent),
    },
    format: 'jwk',
  })
}

function encryptPassword(password: string, publicKeyData: unknown) {
  const key = publicKeyData as { modulus?: unknown; exponent?: unknown }

  if (!key?.modulus || !key?.exponent) {
    throw new Error('无法获取教务系统登录参数')
  }

  const publicKey = createPublicKeyFromJwk(key.modulus, key.exponent)
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(String(password || ''), 'utf8'),
  )

  return encrypted.toString('base64')
}

function isLoginPage(html: unknown) {
  const text = String(html || '')

  return /login_slogin\.html|id=["']yhm["']|id=["']dl["']/.test(text)
}

function assertLoggedIn(html: unknown) {
  if (!html || isLoginPage(html)) {
    throw new Error('学号或密码错误')
  }
}

function parseOptionList(html: unknown, selector: string) {
  const $ = cheerio.load(String(html || ''))
  const options: Array<{ id: string; label: string; selected: boolean }> = []

  $(selector).each((index, option) => {
    const current = $(option)
    const id = cleanText(current.attr('value'))
    const label = cleanText(current.text())

    if (!id && !label) {
      return
    }

    options.push({
      id,
      label,
      selected: Boolean(current.attr('selected')),
    })
  })

  return options
}

function parseSelectedTerm(indexHtml: unknown) {
  const years = parseOptionList(indexHtml, 'select[name="xnm"] option, select#xnm option')
  const terms = parseOptionList(indexHtml, 'select[name="xqm"] option, select#xqm option')
  const selectedYear = years.find((item) => item.selected) || years[0]
  const selectedTerm = terms.find((item) => item.selected) || terms[0]

  return {
    xnm: selectedYear?.id || String(new Date().getFullYear()),
    xqm: selectedTerm?.id || '3',
    years,
    terms,
  }
}

function buildSemesterId(xnm: string, xqm: string) {
  return `${xnm}-${xqm}`
}

function parseSemesterId(value: unknown) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})-(3|12|16)$/)

  return match ? { xnm: match[1], xqm: match[2] } : null
}

function buildSemesters(selectedTerm: ReturnType<typeof parseSelectedTerm>) {
  const years = selectedTerm.years.length
    ? selectedTerm.years
    : [{ id: selectedTerm.xnm, label: `${selectedTerm.xnm}-${Number(selectedTerm.xnm) + 1}` }]
  const terms = selectedTerm.terms.length
    ? selectedTerm.terms
    : [
        { id: '3', label: '第1学期' },
        { id: '12', label: '第2学期' },
        { id: '16', label: '第3学期' },
      ]

  return years.flatMap((year) =>
    terms.map((term) => ({
      id: buildSemesterId(year.id, term.id),
      title: `${year.label || year.id} ${term.label || XQM_LABELS[term.id] || term.id}`,
      label: `${year.label || year.id} ${term.label || XQM_LABELS[term.id] || term.id}`,
      selected: year.id === selectedTerm.xnm && term.id === selectedTerm.xqm,
    })),
  )
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeJwglxtCourse(value: unknown, index: number): ProviderCourse {
  const row = asRecord(value)
  const sections = parseSections(firstValue(row.jcor, row.jcs, row.jc))
  const classroom = cleanText(
    firstValue(row.cdmc && row.lh ? `${row.lh}${row.cdmc}` : '', row.cdmc, row.jxcdmcs),
  )
  const weekday = Number(row.xqj)

  return {
    id: `whhxit-kb-${index + 1}`,
    name: cleanText(row.kcmc) || '未命名课程',
    teacher: cleanText(row.xm),
    location: classroom || '地点待定',
    classroom,
    weekday: Number.isFinite(weekday) ? weekday : 0,
    sections,
    startSection: sections[0],
    endSection: sections[sections.length - 1],
    weeks: parseWeekRange(firstValue(row.zcd, row.zcdstr)),
    rawWeeks: cleanText(firstValue(row.zcd, row.zcdstr)),
    campus: cleanText(row.xqmc),
    remark: cleanText(firstValue(row.kclb, row.kcxz)),
    source: row,
  }
}

function normalizePracticeCourse(value: unknown, index: number): ProviderCourse {
  const row = asRecord(value)

  return {
    id: `whhxit-sjk-${index + 1}`,
    name: cleanText(row.kcmc) || '未命名课程',
    teacher: cleanText(row.jsxm),
    location: cleanText(row.xqmc) || '地点待定',
    classroom: '',
    weekday: 0,
    sections: [],
    weeks: parseWeekRange(firstValue(row.qsjsz, row.sjkcgs, row.qtkcgs)),
    rawWeeks: cleanText(firstValue(row.qsjsz, row.sjkcgs)),
    campus: cleanText(row.xqmc),
    remark: cleanText(firstValue(row.qtkcgs, row.sjkcgs, row.kclb)),
    source: row,
  }
}

function normalizeProfile(xsxx: Record<string, unknown>, fallbackStudentId: string) {
  const studentId = cleanText(xsxx.XH || xsxx.xh) || fallbackStudentId

  return {
    name: cleanText(xsxx.XM || xsxx.xm),
    studentId,
    maskedStudentId: maskStudentId(studentId),
    major: cleanText(xsxx.ZYMC || xsxx.zymc),
    className: cleanText(xsxx.BJMC || xsxx.bjmc),
  }
}

function parseScheduleData(data: unknown, selectedTerm: ReturnType<typeof parseSelectedTerm>, studentId: string) {
  const payload = asRecord(data)
  const kbList = Array.isArray(payload.kbList) ? payload.kbList : []
  const sjkList = Array.isArray(payload.sjkList) ? payload.sjkList : []
  const xsxx = asRecord(payload.xsxx)
  const xnm = cleanText(xsxx.XNM || selectedTerm.xnm)
  const xqm = cleanText(xsxx.XQM || selectedTerm.xqm)
  const termName = cleanText(
    xsxx.XNMC && xsxx.XQMMC
      ? `${xsxx.XNMC} ${xsxx.XQMMC}`
      : `${xnm}-${Number(xnm) + 1} ${XQM_LABELS[xqm] || xqm}`,
  )
  const courses = [
    ...kbList.map(normalizeJwglxtCourse),
    ...sjkList.map(normalizePracticeCourse),
  ]

  return {
    schedule: {
      term: termName,
      selectedSemesterId: buildSemesterId(xnm, xqm),
      semesters: buildSemesters({ ...selectedTerm, xnm, xqm }),
      courses: courses.sort((a, b) => {
        if (a.weekday !== b.weekday) {
          return a.weekday - b.weekday
        }

        return (a.sections?.[0] || 0) - (b.sections?.[0] || 0)
      }),
    },
    profile: normalizeProfile(xsxx, studentId),
  }
}

const whhxitCourseConnector: CourseConnector = {
  async fetchByCredentials(input): Promise<CourseFetchResult> {
    const config = getConfig(input.providerConfig)
    const client = createProviderHttpClient({ baseUrl: config.baseUrl, timeout: 15000 })
    const loginResponse = await client.get(config.loginPath)
    const loginHtml = String(loginResponse.data || '')
    const csrfToken = extractInputValue(loginHtml, 'csrftoken')
    const language = extractInputValue(loginHtml, 'language') || 'zh_CN'
    const ydType = extractInputValue(loginHtml, 'ydType')
    const publicKey = await client.get(`${config.publicKeyPath}?time=${Date.now()}`, {
      headers: { Accept: 'application/json,text/javascript,*/*;q=0.8' },
    })
    const encryptedPassword = encryptPassword(input.password, publicKey.data)

    try {
      await client.post(
        config.logoutPath,
        new URLSearchParams({ csrfTokenLogout: '' }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${config.baseUrl}${config.loginPath}`,
          },
          validateStatus: (status) => status >= 200 && status < 400,
        },
      )
    } catch {
      // The pre-login logout is best-effort and only clears stale server session state.
    }

    const payload = new URLSearchParams({
      csrftoken: csrfToken,
      language,
      ydType,
      yhm: input.username.trim(),
      mm: encryptedPassword,
    })

    const homeResponse = await client.post(
      `${config.loginPath}?time=${Date.now()}`,
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${config.baseUrl}${config.loginPath}`,
        },
        validateStatus: (status) => status >= 200 && status < 400,
      },
    )

    assertLoggedIn(homeResponse.data)

    const indexResponse = await client.get(config.scheduleIndexPath, {
      headers: { Referer: `${config.baseUrl}${config.homePath}` },
    })
    const selectedTerm = parseSelectedTerm(indexResponse.data)
    const requestedTerm = parseSemesterId(input.semesterId)
    const xnm = requestedTerm?.xnm || selectedTerm.xnm
    const xqm = requestedTerm?.xqm || selectedTerm.xqm
    const response = await client.post(
      config.scheduleDataPath,
      new URLSearchParams({ xnm, xqm }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: `${config.baseUrl}${config.scheduleIndexPath}`,
        },
      },
    )

    return parseScheduleData(response.data, { ...selectedTerm, xnm, xqm }, input.username)
  },
}

export const whhxitProvider: SchoolProvider = {
  id: 'whhxit',
  meta: {
    id: 'whhxit',
    name: '武汉华夏理工学院',
    shortName: '华夏理工',
    providerId: 'whhxit',
    loginMode: 'direct_password',
    eduSystemType: 'zf_jwglxt',
    status: 'enabled',
    verifiedAt: '2026-06-12T00:00:00.000Z',
    capabilities: { course: true, score: false, exam: false, profile: true },
    dataAccess: { course: ['server_session'], score: [], exam: [], profile: ['server_session'] },
    featureDisplay: {
      course: {
        title: '课表',
        kind: 'course_grid',
        itemFields: [
          { key: 'name', label: '课程', primary: true },
          { key: 'teacher', label: '教师' },
          { key: 'classroom', label: '教室', fallbackKeys: ['location'] },
          { key: 'campus', label: '校区' },
        ],
        itemPath: 'courses',
        emptyText: '暂无课表数据',
      },
      profile: {
        title: '个人资料',
        kind: 'profile_fields',
        summaryFields: [
          { key: 'name', label: '姓名' },
          { key: 'maskedStudentId', label: '学号', fallbackKeys: ['studentId'] },
          { key: 'major', label: '专业' },
          { key: 'className', label: '班级' },
        ],
        detailFields: [
          { key: 'studentId', label: '学号', editable: false },
          { key: 'major', label: '专业', editable: true },
          { key: 'className', label: '班级', editable: true },
        ],
        editableFields: [
          { key: 'name', label: '姓名' },
          { key: 'major', label: '专业' },
          { key: 'className', label: '班级' },
        ],
        emptyText: '暂无个人资料',
      },
    },
  },
  course: whhxitCourseConnector,
}
