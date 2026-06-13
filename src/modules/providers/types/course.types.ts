export interface Course {
  id?: string
  name: string
  teacher?: string
  classroom?: string
  weekday: number
  startSection: number
  endSection: number
  sections?: number[]
  weeks: number[]
  rawWeeks?: string
  campus?: string
  remark?: string
  source?: unknown
}

export interface SectionTime {
  schoolId: string
  campus?: string
  section: number
  startTime: string
  endTime: string
}
