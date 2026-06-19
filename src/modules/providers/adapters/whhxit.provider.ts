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
    capabilities: { course: true, score: true, exam: true, profile: true },
    credentialSave: {
      passwordVaultAllowed: true,
      autoSync: 'password_login',
      scheduledSyncSupported: true,
      title: '支持保存登录信息',
      notice:
        '保存教务账号密码后，可通过云函数完成首次导入和后续自动同步。账号密码会加密保存在后端，不会用于后端直接访问学校系统。',
      consentLabel: '加密保存账号密码，用于自动同步',
    },
    dataAccess: {
      course: ['cloud_worker', 'webview_client_fetch', 'manual_import'],
      score: ['cloud_worker', 'webview_client_fetch', 'manual_import'],
      exam: ['cloud_worker', 'webview_client_fetch', 'manual_import'],
      profile: ['cloud_worker', 'webview_client_fetch', 'manual_import'],
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
      score: {
        title: '成绩',
        kind: 'score_semesters',
        summaryFields: [
          { key: 'totalCredit', label: '总学分' },
          { key: 'average', label: '平均分' },
          { key: 'gpa', label: '绩点' },
        ],
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
        emptyText: '暂无考试安排',
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
