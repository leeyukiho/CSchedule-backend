import { SchoolProvider } from '../provider.types'

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
    dataAccess: {
      course: ['manual_import'],
      score: [],
      exam: [],
      profile: ['manual_import'],
    },
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
}
