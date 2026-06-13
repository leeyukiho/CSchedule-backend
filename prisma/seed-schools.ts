import { Prisma, PrismaClient } from '@prisma/client'
import * as fs from 'node:fs'
import * as path from 'node:path'

loadEnvFile(path.resolve(__dirname, '../.env'))

const prisma = new PrismaClient()
const CATALOG_FILE = path.resolve(__dirname, './data/school-catalog.json')
const EMPTY_CAPABILITIES = { course: false, score: false, exam: false, profile: false }
const EMPTY_DATA_ACCESS = { course: [], score: [], exam: [], profile: [] }
const CONNECTED_SCHOOLS: ConnectedSchoolSeed[] = [
  {
    id: 'wtbu',
    catalogCode: '4142013242',
    name: '武汉工商学院',
    shortName: '武工商',
    province: '湖北省',
    city: '武汉市',
    aliases: ['武汉工商学院', '武工商', 'WTBU', 'wtbu'],
    providerId: 'wtbu',
    loginMode: 'direct_password',
    eduSystemType: 'eams',
    homepageUrl: 'https://jxgl.wtbu.edu.cn/eams/home.action',
    authUrl: 'https://jxgl.wtbu.edu.cn/eams/home.action',
    verifiedAt: '2026-06-12T00:00:00.000Z',
    capabilities: { course: true, score: true, exam: true, profile: true },
    dataAccess: {
      course: ['server_session'],
      score: ['server_session'],
      exam: ['server_session'],
      profile: ['server_session'],
    },
    providerConfig: {
      baseUrl: 'https://jxgl.wtbu.edu.cn',
      system: 'EAMS',
      scheduleParser: 'TaskActivity',
      authConfig: {
        captchaRequired: false,
        captchaKind: 'none',
        uiPreset: 'password',
        passwordTransform: 'sha1_salt',
      },
    },
  },
  {
    id: 'whhxit',
    catalogCode: '4142013666',
    name: '武汉华夏理工学院',
    shortName: '华夏理工',
    province: '湖北省',
    city: '武汉市',
    aliases: ['武汉华夏理工学院', '华夏理工学院', '华夏理工', 'WHHXIT', 'whhxit'],
    providerId: 'whhxit',
    loginMode: 'direct_password',
    eduSystemType: 'zf_jwglxt',
    homepageUrl: 'https://jwgl.whhxit.edu.cn/',
    authUrl: 'https://jwgl.whhxit.edu.cn/jwglxt/xtgl/login_slogin.html',
    verifiedAt: '2026-06-12T00:00:00.000Z',
    capabilities: { course: true, score: false, exam: false, profile: true },
    dataAccess: {
      course: ['server_session'],
      score: [],
      exam: [],
      profile: ['server_session'],
    },
    providerConfig: {
      baseUrl: 'https://jwgl.whhxit.edu.cn',
      system: 'ZF jwglxt V9.0',
      schedulePath: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151',
      termParams: { first: '3', second: '12', third: '16' },
      authConfig: {
        captchaRequired: false,
        captchaKind: 'none',
        uiPreset: 'password',
        passwordTransform: 'rsa_public_key',
      },
    },
  },
]

interface SchoolCatalogFile {
  source: string
  sourceDate: string
  schools: SchoolCatalogItem[]
}

interface SchoolCatalogItem {
  id: string
  code: string
  name: string
  province: string
  city: string
  level: string
  isPrivate: boolean
}

interface ConnectedSchoolSeed {
  id: string
  catalogCode: string
  name: string
  shortName: string
  province: string
  city: string
  aliases: string[]
  providerId: string
  loginMode: 'direct_password'
  eduSystemType: string
  homepageUrl: string
  authUrl: string
  verifiedAt: string
  capabilities: typeof EMPTY_CAPABILITIES
  dataAccess: {
    course: string[]
    score: string[]
    exam: string[]
    profile: string[]
  }
  providerConfig: Record<string, unknown>
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

function loadEnvFile(envFile: string) {
  if (!fs.existsSync(envFile)) {
    return
  }

  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')

    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '')

    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

function readCatalogFile(): SchoolCatalogFile {
  return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) as SchoolCatalogFile
}

async function main() {
  const catalog = readCatalogFile()

  if (!Array.isArray(catalog.schools) || catalog.schools.length === 0) {
    throw new Error(`No schools found in ${CATALOG_FILE}`)
  }

  for (const school of catalog.schools) {
    await prisma.school.upsert({
      where: { id: school.id },
      create: {
        id: school.id,
        name: school.name,
        province: school.province || undefined,
        city: school.city || undefined,
        enabled: false,
        status: 'catalog_only',
        capabilities: EMPTY_CAPABILITIES,
        dataAccess: EMPTY_DATA_ACCESS,
        config: {
          catalog: {
            source: catalog.source,
            sourceDate: catalog.sourceDate,
            code: school.code,
            level: school.level,
            isPrivate: school.isPrivate,
          },
        },
      },
      update: {
        name: school.name,
        province: school.province || undefined,
        city: school.city || undefined,
        config: {
          catalog: {
            source: catalog.source,
            sourceDate: catalog.sourceDate,
            code: school.code,
            level: school.level,
            isPrivate: school.isPrivate,
          },
        },
      },
    })
  }

  for (const school of CONNECTED_SCHOOLS) {
    const catalogItem = catalog.schools.find((item) => item.code === school.catalogCode)
    const catalogConfig = {
      source: catalog.source,
      sourceDate: catalog.sourceDate,
      code: school.catalogCode,
      level: catalogItem?.level,
      isPrivate: catalogItem?.isPrivate,
    }
    const verifiedAt = new Date(school.verifiedAt)

    await prisma.school.upsert({
      where: { id: school.id },
      create: {
        id: school.id,
        name: school.name,
        shortName: school.shortName,
        province: school.province,
        city: school.city,
        aliases: school.aliases,
        providerId: school.providerId,
        loginMode: school.loginMode,
        dataAccess: school.dataAccess,
        capabilities: school.capabilities,
        eduSystemType: school.eduSystemType,
        homepageUrl: school.homepageUrl,
        authUrl: school.authUrl,
        enabled: true,
        status: 'enabled',
        verifiedAt,
        config: toJson({
          catalog: catalogConfig,
          provider: {
            ...school.providerConfig,
            credentialPolicy: createCredentialPolicy(school.capabilities),
          },
        }),
      },
      update: {
        name: school.name,
        shortName: school.shortName,
        province: school.province,
        city: school.city,
        aliases: school.aliases,
        providerId: school.providerId,
        loginMode: school.loginMode,
        dataAccess: school.dataAccess,
        capabilities: school.capabilities,
        eduSystemType: school.eduSystemType,
        homepageUrl: school.homepageUrl,
        authUrl: school.authUrl,
        enabled: true,
        status: 'enabled',
        verifiedAt,
        config: toJson({
          catalog: catalogConfig,
          provider: {
            ...school.providerConfig,
            credentialPolicy: createCredentialPolicy(school.capabilities),
          },
        }),
      },
    })
  }

  console.log(`Seeded ${catalog.schools.length} catalog schools and ${CONNECTED_SCHOOLS.length} connected schools from ${CATALOG_FILE}`)
}

function createCredentialPolicy(capabilities: typeof EMPTY_CAPABILITIES) {
  return {
    saveMode: 'password_vault',
    userConsentRequired: true,
    maxSessionTtlMinutes: 720,
    maxPasswordTtlDays: 180,
    autoRefreshAllowed: true,
    backgroundRefreshTargets: Object.entries(capabilities)
      .filter(([, enabled]) => enabled)
      .map(([target]) => target),
    requiresReauthOnFailure: true,
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
