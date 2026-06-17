import { SchoolProvider } from '../provider.types'

export const whggvcProvider: SchoolProvider = {
  id: 'whggvc',
  meta: {
    id: 'whggvc',
    name: '武汉光谷职业学院',
    shortName: '光谷职院',
    providerId: 'whggvc',
    loginMode: 'direct_password',
    eduSystemType: 'custom',
    status: 'beta',
    verifiedAt: '2026-06-15T00:00:00.000Z',
    capabilities: { course: true, score: true, exam: true, profile: true },
    dataAccess: {
      course: ['webview_client_fetch', 'manual_import'],
      score: ['webview_client_fetch', 'manual_import'],
      exam: ['webview_client_fetch', 'manual_import'],
      profile: ['webview_client_fetch', 'manual_import'],
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
      exam: {
        title: '考试',
        kind: 'exam_list',
        itemFields: [
          { key: 'name', label: '课程', primary: true },
          { key: 'date', label: '日期' },
          { key: 'startTime', label: '开始' },
          { key: 'endTime', label: '结束' },
          { key: 'classroom', label: '考场' },
          { key: 'seatNumber', label: '座位' },
        ],
        emptyText: '暂无考试安排',
      },
      profile: {
        title: '个人资料',
        kind: 'profile_fields',
        summaryFields: [
          { key: 'name', label: '姓名' },
          {
            key: 'maskedStudentId',
            label: '学号',
            fallbackKeys: ['studentId'],
          },
          { key: 'gender', label: '性别' },
          { key: 'phone', label: '手机' },
        ],
        detailFields: [
          { key: 'studentId', label: '学号', editable: false },
          { key: 'gender', label: '性别', editable: true },
          { key: 'birthDate', label: '生日', editable: true },
          { key: 'phone', label: '手机', editable: true },
          { key: 'email', label: '邮箱', editable: true },
        ],
        editableFields: [
          { key: 'name', label: '姓名' },
          { key: 'gender', label: '性别' },
          { key: 'birthDate', label: '生日' },
          { key: 'phone', label: '手机' },
          { key: 'email', label: '邮箱' },
        ],
        emptyText: '暂无个人资料',
      },
    },
  },
}
