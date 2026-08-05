import type { CommandDescriptor } from './types'

export class CommandRegistry {
  private readonly byId = new Map<string, CommandDescriptor>()
  private readonly byName = new Map<string, string>()

  registerMany(descriptors: CommandDescriptor[]): void {
    for (const descriptor of descriptors) this.register(descriptor)
  }

  register(descriptor: CommandDescriptor): void {
    if (this.byId.has(descriptor.id))
      throw new Error(`duplicate command id: ${descriptor.id}`)
    const names = [
      descriptor.name,
      ...descriptor.aliases,
      ...(descriptor.hiddenAliases ?? []),
    ].map(normalizeName)
    for (const name of names) {
      const owner = this.byName.get(name)
      if (owner) throw new Error(`command name is already registered: ${name}`)
    }
    const frozen = cloneDescriptor(descriptor)
    this.byId.set(frozen.id, frozen)
    for (const name of names) this.byName.set(name, frozen.id)
  }

  get(id: string): CommandDescriptor | null {
    const found = this.byId.get(String(id))
    return found ? cloneDescriptor(found) : null
  }

  resolveName(name: string): CommandDescriptor | null {
    const id = this.byName.get(normalizeName(name))
    return id ? this.get(id) : null
  }

  list(): CommandDescriptor[] {
    return [...this.byId.values()].map(cloneDescriptor)
  }

  reservedNames(): Set<string> {
    return new Set(this.byName.keys())
  }
}

function normalizeName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase()
}

function cloneDescriptor(value: CommandDescriptor): CommandDescriptor {
  return {
    ...value,
    aliases: [...value.aliases],
    hiddenAliases: value.hiddenAliases ? [...value.hiddenAliases] : undefined,
    invocationSources: [...value.invocationSources],
    sensitiveArguments: value.sensitiveArguments
      ? [...value.sensitiveArguments]
      : undefined,
    argumentSchema: value.argumentSchema.map((item) => ({
      ...item,
      values: item.values ? [...item.values] : undefined,
    })),
    skill: value.skill
      ? { ...value.skill, allowedTools: [...value.skill.allowedTools] }
      : undefined,
  }
}
