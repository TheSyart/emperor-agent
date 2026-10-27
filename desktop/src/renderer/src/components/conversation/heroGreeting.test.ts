import { describe, expect, it } from 'vitest'
import { heroHeadline, heroNote, heroPlaceholder } from './heroGreeting'

describe('heroHeadline (UI-S17, MOD-03 1)', () => {
  it('greets a Chat home by the profile 称呼', () => {
    expect(heroHeadline('小周')).toBe('小周，今天想聊点什么？')
    expect(heroHeadline('  Anran ', 'chat')).toBe('Anran，今天想聊点什么？')
  })

  it('drops the prefix without a name', () => {
    expect(heroHeadline(null)).toBe('今天想聊点什么？')
    expect(heroHeadline(undefined, 'chat')).toBe('今天想聊点什么？')
    expect(heroHeadline('   ')).toBe('今天想聊点什么？')
  })

  it('asks Build for a project and Group for someone, without the name', () => {
    expect(heroHeadline('小周', 'build')).toBe('今天推进哪个项目？')
    expect(heroHeadline(null, 'build')).toBe('今天推进哪个项目？')
    expect(heroHeadline('小周', 'group')).toBe('今天找谁帮忙？')
  })

  it('cuts a long name to 12 characters', () => {
    expect(heroHeadline('周'.repeat(20))).toBe(
      `${'周'.repeat(12)}…，今天想聊点什么？`,
    )
    expect(heroHeadline('😀'.repeat(13))).toBe(
      `${'😀'.repeat(12)}…，今天想聊点什么？`,
    )
  })
})

describe('the line under the headline and the placeholder (MOD-03)', () => {
  it('says what a Build session can do; Chat has no line', () => {
    expect(heroNote('chat')).toBe('')
    expect(heroNote('build')).toBe(
      '构建会话都在某个项目文件夹里运行，可以读写文件、跑命令。',
    )
    expect(heroNote('group')).toBe(
      '@ 一位联系人就是单聊；@ 几位，会建一个临时群。',
    )
  })

  it('asks Chat for anything and Build for a change', () => {
    expect(heroPlaceholder('chat')).toBe(
      '问任何问题，或者让我写点什么；/ 调用技能，@ 引用插件',
    )
    expect(heroPlaceholder('build')).toBe(
      '描述要做的改动，或者粘贴报错；/ 调用技能，@ 引用插件',
    )
  })
})
