import type { ExecutorProfile } from './types'

/** Recommendations, not model rankings or evidence of tool availability. */
export function executorSpecialties(
  profile: Pick<ExecutorProfile, 'backend' | 'specialties'>,
): string[] {
  return [
    ...(profile.specialties ??
      (profile.backend === 'codex'
        ? ['工程实现', '代码审查', '资料调研']
        : ['代码理解', '重构调试', '测试补全'])),
  ]
}
