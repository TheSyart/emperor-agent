import type { ExecutorProfile, ExternalBackend } from './types'

/** Product descriptions, not evidence that a local model or tool is available. */
export function executorIntroduction(backend: ExternalBackend): string {
  return backend === 'codex'
    ? 'OpenAI 的编程智能体，可修改项目、执行测试与代码审查；支持联网搜索和原生生图，用于资料核查与图像素材制作。'
    : 'Anthropic 的编程智能体，可理解代码库、跨文件开发和重构、定位问题并运行测试，也能联网查阅文档。'
}

/** Recommendations, not model rankings or evidence of tool availability. */
export function executorSpecialties(
  profile: Pick<ExecutorProfile, 'backend' | 'specialties'>,
): string[] {
  return [
    ...(profile.specialties ??
      (profile.backend === 'codex'
        ? ['功能开发', '代码审查', '测试排错', '联网调研', '图像生成']
        : ['代码库理解', '功能开发', '重构排错', '测试补全', '文档检索'])),
  ]
}
