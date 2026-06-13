import { DataAccessMode, DataTarget } from '../provider.types'
import { SectionTime } from './course.types'
import { Term } from '../shared/term-parser'

export interface FeatureQuery {
  termId?: string
  year?: string
  semester?: string
  week?: number
  extra?: Record<string, unknown>
}

export interface FeatureParseContext {
  schoolId: string
  providerId: string
  target: DataTarget
  term?: Term
  sectionTimes?: SectionTime[]
  sourceMeta?: Record<string, unknown>
}

export interface FeatureConnector<RawPayload, ParsedModel> {
  target: DataTarget
  supportedAccessModes: DataAccessMode[]
  getTerms?: (session: unknown) => Promise<Term[]>
  fetchRaw?: (session: unknown, query: FeatureQuery) => Promise<RawPayload>
  parse: (raw: RawPayload, context: FeatureParseContext) => Promise<ParsedModel[]>
}
