import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import {
  DataTarget,
  FeatureDisplayConfig,
  FeatureDisplayField,
  SectionTimeConfig,
} from './provider.types'
import { ProviderRegistryService } from './provider-registry.service'

const PROFILE_EDITABLE_FIELDS = [
  'name',
  'major',
  'grade',
  'level',
  'className',
  'gender',
  'birthDate',
  'politicalStatus',
  'phone',
  'email',
  'nativePlace',
  'enrollmentDate',
  'studentStatus',
  'dormitory',
  'counselor',
]

@Injectable()
export class ProviderDisplayService {
  constructor(private readonly providers: ProviderRegistryService) {}

  getDisplay(
    schoolConfig: Prisma.JsonValue | null,
    providerId: string,
    target: DataTarget,
  ) {
    return (
      this.getSchoolDisplay(schoolConfig, target) ??
      this.getProviderDisplay(providerId, target) ??
      this.getDefaultDisplay(target)
    )
  }

  getSectionTimes(
    schoolConfig: Prisma.JsonValue | null,
    providerId: string,
  ): SectionTimeConfig[] {
    const config = this.asRecord(schoolConfig)
    const provider = this.asRecord(config.provider)
    const schoolTimes = this.asSectionTimes(config.sectionTimes ?? provider.sectionTimes)

    if (schoolTimes.length) {
      return schoolTimes
    }

    try {
      return this.asSectionTimes(this.providers.getProvider(providerId).meta.sectionTimes)
    } catch {
      return []
    }
  }

  private getSchoolDisplay(schoolConfig: Prisma.JsonValue | null, target: DataTarget) {
    const config = this.asRecord(schoolConfig)
    const provider = this.asRecord(config.provider)
    const displaySource = this.asRecord(config.featureDisplay)
    const providerDisplaySource = this.asRecord(provider.featureDisplay)
    const display = displaySource[target] ?? providerDisplaySource[target]

    return this.asDisplay(display)
  }

  private getProviderDisplay(providerId: string, target: DataTarget) {
    try {
      const provider = this.providers.getProvider(providerId)
      return this.asDisplay(provider.meta.featureDisplay?.[target])
    } catch {
      return undefined
    }
  }

  private getDefaultDisplay(target: DataTarget): FeatureDisplayConfig {
    if (target === 'course') {
      return {
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
      }
    }

    if (target === 'score') {
      return {
        title: '成绩',
        kind: 'score_semesters',
        summaryFields: [
          { key: 'totalCredit', label: '总学分' },
          { key: 'average', label: '平均分' },
          { key: 'gpa', label: '绩点' },
        ],
        itemFields: [
          { key: 'name', label: '课程' },
          { key: 'credit', label: '学分' },
          { key: 'score', label: '成绩', primary: true },
          { key: 'gpa', label: '绩点' },
        ],
        groupPath: 'semesters',
        itemPath: 'grades',
        emptyText: '暂无成绩缓存',
      }
    }

    if (target === 'exam') {
      return {
        title: '考试',
        kind: 'exam_list',
        emptyText: '暂无考试缓存',
      }
    }

    return {
      title: '个人资料',
      kind: 'profile_fields',
      summaryFields: [
        { key: 'name', label: '姓名', fallbackKeys: ['displayName'] },
        { key: 'maskedStudentId', label: '学号', fallbackKeys: ['studentId'] },
        { key: 'major', label: '专业' },
        { key: 'className', label: '班级' },
        { key: 'level', label: '层次', fallbackKeys: ['grade'] },
      ],
      detailFields: PROFILE_EDITABLE_FIELDS.map((key) => ({
        key,
        label: key,
        editable: true,
      })),
      editableFields: PROFILE_EDITABLE_FIELDS.map((key) => ({
        key,
        label: key,
      })),
      emptyText: '暂无个人资料',
    }
  }

  private asDisplay(value: unknown): FeatureDisplayConfig | undefined {
    const source = this.asRecord(value)

    if (!Object.keys(source).length) {
      return undefined
    }

    return {
      title: typeof source.title === 'string' ? source.title : undefined,
      kind: this.asDisplayKind(source.kind),
      summaryFields: this.asDisplayFields(source.summaryFields),
      detailFields: this.asDisplayFields(source.detailFields),
      editableFields: this.asDisplayFields(source.editableFields),
      itemFields: this.asDisplayFields(source.itemFields),
      itemPath: typeof source.itemPath === 'string' ? source.itemPath : undefined,
      groupPath: typeof source.groupPath === 'string' ? source.groupPath : undefined,
      emptyText: typeof source.emptyText === 'string' ? source.emptyText : undefined,
    }
  }

  private asDisplayKind(value: unknown): FeatureDisplayConfig['kind'] | undefined {
    return ['course_grid', 'profile_fields', 'score_semesters', 'exam_list', 'raw'].includes(
      String(value),
    )
      ? (value as FeatureDisplayConfig['kind'])
      : undefined
  }

  private asDisplayFields(value: unknown): FeatureDisplayField[] | undefined {
    if (!Array.isArray(value)) {
      return undefined
    }

    const fields = value.reduce<FeatureDisplayField[]>((result, item) => {
      const source = this.asRecord(item)
      const key = typeof source.key === 'string' ? source.key.trim() : ''
      const label = typeof source.label === 'string' ? source.label.trim() : key

      if (!key || !label) {
        return result
      }

      result.push({
        key,
        label,
        visible: typeof source.visible === 'boolean' ? source.visible : undefined,
        editable: typeof source.editable === 'boolean' ? source.editable : undefined,
        primary: typeof source.primary === 'boolean' ? source.primary : undefined,
        fallbackKeys: Array.isArray(source.fallbackKeys)
          ? source.fallbackKeys.filter((fallbackKey): fallbackKey is string => typeof fallbackKey === 'string')
          : undefined,
      })

      return result
    }, [])

    return fields.length ? fields : undefined
  }

  private asSectionTimes(value: unknown): SectionTimeConfig[] {
    if (!Array.isArray(value)) {
      return []
    }

    return value.reduce<SectionTimeConfig[]>((result, item, index) => {
      const source = this.asRecord(item)
      const section = Number(
        source.section ??
          source.index ??
          source.no ??
          source.id ??
          source.lesson ??
          source.period ??
          index + 1,
      )
      const start = typeof source.start === 'string'
        ? source.start.trim()
        : typeof source.startTime === 'string'
          ? source.startTime.trim()
          : typeof source.begin === 'string'
            ? source.begin.trim()
            : ''
      const end = typeof source.end === 'string'
        ? source.end.trim()
        : typeof source.endTime === 'string'
          ? source.endTime.trim()
          : typeof source.finish === 'string'
            ? source.finish.trim()
            : ''

      if (Number.isInteger(section) && section > 0 && start && end) {
        result.push({ section, start, end })
      }

      return result
    }, [])
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
}
