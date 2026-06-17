import { Prisma, PrismaClient } from '@prisma/client'
import * as fs from 'node:fs'
import * as path from 'node:path'

loadEnvFile(path.resolve(__dirname, '../.env'))

const prisma = new PrismaClient()
const CATALOG_FILE = path.resolve(__dirname, './data/school-catalog.json')
const CONNECTED_SCHOOLS_FILE = path.resolve(
  __dirname,
  './data/connected-schools.json',
)
const EMPTY_CAPABILITIES = {
  course: false,
  score: false,
  exam: false,
  profile: false,
}
const EMPTY_DATA_ACCESS = { course: [], score: [], exam: [], profile: [] }
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
  loginMode:
    | 'direct_password'
    | 'password_captcha'
    | 'cas_simple'
    | 'cas_webview'
    | 'oauth_webview'
    | 'qrcode'
  eduSystemType: string
  homepageUrl: string
  authUrl: string
  verifiedAt: string
  status?:
    | 'catalog_only'
    | 'candidate'
    | 'researching'
    | 'beta'
    | 'enabled'
    | 'disabled'
  enabled?: boolean
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
    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, '')

    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

function readCatalogFile(): SchoolCatalogFile {
  return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) as SchoolCatalogFile
}

function readConnectedSchoolsFile(): ConnectedSchoolSeed[] {
  if (!fs.existsSync(CONNECTED_SCHOOLS_FILE)) {
    throw new Error(`Connected schools file not found: ${CONNECTED_SCHOOLS_FILE}`)
  }

  const payload = JSON.parse(
    fs.readFileSync(CONNECTED_SCHOOLS_FILE, 'utf8'),
  ) as ConnectedSchoolSeed[] | { schools?: ConnectedSchoolSeed[] }
  const schools = Array.isArray(payload) ? payload : payload.schools

  if (!Array.isArray(schools)) {
    throw new Error(`No connected schools found in ${CONNECTED_SCHOOLS_FILE}`)
  }

  return schools
}

function resolveSeedStatus(school: ConnectedSchoolSeed) {
  return school.status ?? (school.enabled === false ? 'disabled' : 'enabled')
}

async function main() {
  const catalog = readCatalogFile()
  const connectedSchools = readConnectedSchoolsFile()

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

  for (const school of connectedSchools) {
    const catalogItem = catalog.schools.find(
      (item) => item.code === school.catalogCode,
    )
    const status = resolveSeedStatus(school)
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
        enabled: status === 'enabled',
        status,
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
        enabled: status === 'enabled',
        status,
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

  console.log(
    `Seeded ${catalog.schools.length} catalog schools and ${connectedSchools.length} connected schools from ${CATALOG_FILE}`,
  )
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
