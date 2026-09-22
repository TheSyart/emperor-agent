import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSkillsLoader, SkillLoaders } from './file-loader'
import { checkSkillContent, referencedPaths } from './validate'

function roots() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-skill-loader-'))
  const stateRoot = join(root, 'state')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(join(stateRoot, 'skills'), { recursive: true })
  mkdirSync(join(runtimeRoot, 'skills'), { recursive: true })
  return { root, stateRoot, runtimeRoot, userSkills: join(stateRoot, 'skills') }
}

function skill(dir: string, frontmatter: string, body = '# Body\n'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  return dir
}

describe('relaxed Skill validation', () => {
  it('parses duplicate keys leniently (last wins) with a warning', () => {
    const check = checkSkillContent(
      '---\nname: first\nname: dup-skill\ndescription: Works\n---\n',
    )
    expect(check.errors).toEqual([])
    expect(check.name).toBe('dup-skill')
    expect(check.warnings.join('\n')).toMatch(/Duplicate frontmatter key.*name/)
  })

  it('falls back to simple key: value lines for broken YAML', () => {
    const check = checkSkillContent(
      '---\nname: colon-skill\ndescription: Use when: the user asks\n---\n',
    )
    expect(check.errors).toEqual([])
    expect(check.description).toBe('Use when: the user asks')
    expect(check.warnings.join('\n')).toMatch(/could not be parsed/)
  })

  it('warns on a folder name mismatch and errors on bad names', () => {
    expect(
      checkSkillContent('---\nname: real-name\ndescription: x\n---\n', {
        folderName: 'folder',
      }).warnings.join('\n'),
    ).toMatch(/differs from frontmatter name "real-name"/)
    expect(
      checkSkillContent(
        '---\nname: Upper\ndescription: x\n---\n',
      ).errors.join(),
    ).toMatch(/Skill name must start/)
    expect(
      checkSkillContent('---\nname: v1.2_tool-x\ndescription: x\n---\n').errors,
    ).toEqual([])
  })

  it('collects relative references from Markdown links only', () => {
    expect(
      referencedPaths(
        [
          'See [guide](references/guide.md#top) and ![logo](./assets/logo.png).',
          'Example paths in code such as `scripts/example.py` are not references.',
          'Ignore [site](https://example.com), [anchor](#x), [abs](/etc/passwd), [glob](references/*.md).',
        ].join('\n'),
      ),
    ).toEqual(['references/guide.md', 'assets/logo.png'])
  })
})

describe('FileSkillsLoader', () => {
  it('accepts venvs, dependency folders, and internal links; rejects escaping links', () => {
    const { root, stateRoot, runtimeRoot, userSkills } = roots()
    const venvSkill = skill(
      join(userSkills, 'py-tool'),
      'name: py-tool\ndescription: Python tool',
      'Run [the script](scripts/run.py).\n',
    )
    mkdirSync(join(venvSkill, 'scripts'))
    writeFileSync(join(venvSkill, 'scripts', 'run.py'), 'print(1)\n')
    mkdirSync(join(venvSkill, '.venv', 'bin'), { recursive: true })
    symlinkSync('/usr/bin/python3', join(venvSkill, '.venv', 'bin', 'python'))
    mkdirSync(join(venvSkill, 'node_modules', 'pkg'), { recursive: true })
    symlinkSync(root, join(venvSkill, 'node_modules', 'pkg', 'escape'))
    symlinkSync(join('scripts', 'run.py'), join(venvSkill, 'run.py'))

    const leaky = skill(
      join(userSkills, 'leaky'),
      'name: leaky\ndescription: Leaks',
    )
    symlinkSync('../../..', join(leaky, 'up'))
    const absolute = skill(
      join(userSkills, 'absolute'),
      'name: absolute\ndescription: Absolute link',
    )
    symlinkSync(join(absolute, 'SKILL.md'), join(absolute, 'copy.md'))

    const scan = new FileSkillsLoader({ runtimeRoot, stateRoot }).scan()

    expect(scan.skills.map((entry) => entry.name)).toEqual(['py-tool'])
    expect(scan.skills[0]).toMatchObject({
      source: 'user',
      readOnly: false,
      warnings: [],
    })
    expect(scan.invalid).toEqual([
      expect.objectContaining({
        name: 'absolute',
        reason: expect.stringMatching(/absolute target: copy\.md/),
      }),
      expect.objectContaining({
        name: 'leaky',
        reason: expect.stringMatching(/points outside the Skill folder: up/),
      }),
    ])
  })

  it('names Skills by frontmatter and reports missing references as warnings', () => {
    const { stateRoot, runtimeRoot, userSkills } = roots()
    skill(
      join(userSkills, 'Folder Name'),
      'name: actual-name\ndescription: Named in frontmatter',
      'Read [missing](references/missing.md).\n',
    )
    const scan = new FileSkillsLoader({ runtimeRoot, stateRoot }).scan()
    expect(scan.skills).toHaveLength(1)
    expect(scan.skills[0]!.name).toBe('actual-name')
    expect(scan.skills[0]!.warnings).toEqual([
      'Folder name "Folder Name" differs from frontmatter name "actual-name"; the Skill is named "actual-name"',
      'Referenced file is missing: references/missing.md',
    ])
  })

  it('counts flat <name>.md files only with name + description frontmatter', () => {
    const { stateRoot, runtimeRoot, userSkills } = roots()
    writeFileSync(
      join(userSkills, 'quick.md'),
      '---\nname: quick\ndescription: Quick flat skill\n---\nDo it.\n',
    )
    writeFileSync(join(userSkills, 'notes.md'), '# Just notes\n')
    writeFileSync(
      join(userSkills, 'partial.md'),
      '---\ntitle: Not a skill\n---\nBody\n',
    )
    const loader = new FileSkillsLoader({ runtimeRoot, stateRoot })
    const scan = loader.scan()
    expect(scan.skills.map((entry) => [entry.name, entry.flat])).toEqual([
      ['quick', true],
    ])
    expect(scan.invalid).toEqual([])
    expect(loader.resolve('quick')?.skillFile).toBe(
      join(userSkills, 'quick.md'),
    )
  })

  it('applies project > user > plugin > builtin precedence and read-only flags', () => {
    const { root, stateRoot, runtimeRoot, userSkills } = roots()
    const project = join(root, 'project')
    const plugin = join(root, 'plugin-skills')
    skill(
      join(runtimeRoot, 'skills', 'shared'),
      'name: shared\ndescription: builtin',
    )
    skill(join(plugin, 'shared'), 'name: shared\ndescription: plugin')
    skill(join(plugin, 'plugin-only'), 'name: plugin-only\ndescription: plugin')
    skill(join(userSkills, 'shared'), 'name: shared\ndescription: user')
    skill(
      join(project, '.emperor', 'skills', 'shared'),
      'name: shared\ndescription: project',
    )
    const loader = new FileSkillsLoader({
      runtimeRoot,
      stateRoot,
      projectRoot: project,
      pluginRoots: () => [plugin],
    })
    const scan = loader.scan()
    expect(
      scan.skills.map((entry) => [entry.name, entry.source, entry.readOnly]),
    ).toEqual([
      ['plugin-only', 'plugin', true],
      ['shared', 'project', false],
    ])
    expect(scan.shadowed.map((entry) => entry.source)).toEqual([
      'user',
      'plugin',
      'builtin',
    ])
    expect(
      loader.configResolutions().map((resolved) => resolved.value?.source),
    ).toEqual(['plugin', 'project'])
  })

  it('keeps one loader per project root so sessions never see another project', () => {
    const { root, stateRoot, runtimeRoot } = roots()
    const alpha = join(root, 'alpha')
    const beta = join(root, 'beta')
    skill(
      join(alpha, '.emperor', 'skills', 'alpha-only'),
      'name: alpha-only\ndescription: a',
    )
    skill(
      join(beta, '.emperor', 'skills', 'beta-only'),
      'name: beta-only\ndescription: b',
    )
    const loaders = new SkillLoaders({ runtimeRoot, stateRoot })
    let rootsChanged = 0
    loaders.onRootsChanged(() => {
      rootsChanged += 1
    })

    const alphaLoader = loaders.forProject(alpha)
    const betaLoader = loaders.forProject(beta)
    expect(loaders.forProject(alpha)).toBe(alphaLoader)
    expect(alphaLoader.resolvedSkills().map((entry) => entry.name)).toEqual([
      'alpha-only',
    ])
    expect(betaLoader.resolvedSkills().map((entry) => entry.name)).toEqual([
      'beta-only',
    ])
    // Reading beta never re-points alpha (the old shared loader did).
    expect(alphaLoader.resolve('beta-only')).toBeNull()
    expect(loaders.forProject(null).resolvedSkills()).toEqual([])
    expect(rootsChanged).toBe(2)
    expect(loaders.watchRoots()).toEqual([
      join(stateRoot, 'skills'),
      join(alpha, '.emperor', 'skills'),
      join(beta, '.emperor', 'skills'),
    ])
    loaders.setPluginSkillsRoots([join(root, 'plugin')])
    expect(rootsChanged).toBe(3)
    expect(loaders.watchRoots()).toContain(join(root, 'plugin'))
  })
})
