import { Course } from '../types/course.types'

export interface NormalizeContext {
  schoolId: string
  providerId: string
}

export interface CourseNormalizer {
  normalize(input: Course[], context: NormalizeContext): Course[]
}
