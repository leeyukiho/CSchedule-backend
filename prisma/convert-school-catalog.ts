import * as fs from 'node:fs'
import * as path from 'node:path'
import * as XLSX from 'xlsx'

const DEFAULT_SOURCE_FILE = path.resolve(__dirname, '../../docs/W020250729615142156867.xls')
const DEFAULT_OUTPUT_FILE = path.resolve(__dirname, './data/school-catalog.json')
const PROVINCE_GROUP_RE = /\uff08\d+\u6240\uff09$/
const PRIVATE_REMARK = '\u6c11\u529e'

interface SchoolCatalogItem {
  id: string
  code: string
  name: string
  province: string
  city: string
  level: string
  isPrivate: boolean
}

function normalizeCell(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeProvince(value: string) {
  return value.replace(PROVINCE_GROUP_RE, '').trim()
}

function createSchoolId(code: string) {
  return `moe_${code}`
}

function readCatalog(sourceFile: string): SchoolCatalogItem[] {
  const workbook = XLSX.readFile(sourceFile)
  const firstSheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
  })
  const schools: SchoolCatalogItem[] = []
  let province = ''

  for (const row of rows) {
    const cells = row.map(normalizeCell)
    const sequence = Number(cells[0])

    if (!Number.isFinite(sequence)) {
      const provinceCell = cells[0]

      if (PROVINCE_GROUP_RE.test(provinceCell)) {
        province = normalizeProvince(provinceCell)
      }

      continue
    }

    const [, name, code, , city, level, remark] = cells

    if (!name || !code) {
      continue
    }

    schools.push({
      id: createSchoolId(code),
      code,
      name,
      province,
      city,
      level,
      isPrivate: remark.includes(PRIVATE_REMARK),
    })
  }

  return schools
}

function main() {
  const sourceFile = path.resolve(process.argv[2] || DEFAULT_SOURCE_FILE)
  const outputFile = path.resolve(process.argv[3] || DEFAULT_OUTPUT_FILE)
  const schools = readCatalog(sourceFile)

  if (schools.length === 0) {
    throw new Error(`No schools parsed from ${sourceFile}`)
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(
    outputFile,
    `${JSON.stringify(
      {
        source: 'moe-national-schools',
        sourceDate: '2025-06-20',
        schools,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`Wrote ${schools.length} schools to ${outputFile}`)
}

main()
