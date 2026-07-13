import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('renderer routes', () => {
  it('keeps plugin and settings routes addressable', async () => {
    const { routeRecords } = await import('./router')
    const paths = routeRecords.map((route) => route.path)

    expect(paths).toContain('/plugins')
    expect(paths).toContain('/plugins/:tab?')
    expect(paths).toContain('/skills/:name?')
    expect(paths).toContain('/tools')
    expect(paths).toContain('/mcp')
    expect(paths).toContain('/settings/:section?')
  })

  it('moves MCP configuration under the plugins hub while keeping legacy routes', async () => {
    const { routeRecords } = await import('./router')
    const mcp = routeRecords.find((route) => route.path === '/mcp')
    const settingsIntegrations = routeRecords.find(
      (route) => route.path === '/settings/integrations',
    )

    expect(mcp?.redirect).toBe('/plugins/mcp')
    expect(settingsIntegrations?.redirect).toBe('/plugins/mcp')
  })

  it('redirects legacy team route to chat instead of exposing management UI', async () => {
    const { routeRecords } = await import('./router')
    const team = routeRecords.find((route) => route.path === '/team')

    expect(team?.redirect).toBe('/chat')
    expect(team?.component).toBeUndefined()
  })

  it('redirects the legacy model route into the settings model page', async () => {
    const { routeRecords } = await import('./router')
    const model = routeRecords.find((route) => route.path === '/model')

    expect(model?.redirect).toBe('/settings/model')
    expect(model?.component).toBeUndefined()
  })

  it('marks settings as a standalone shell without the app sidebar', async () => {
    const { routeRecords } = await import('./router')
    const settings = routeRecords.find(
      (route) => route.path === '/settings/:section?',
    )
    const chat = routeRecords.find((route) => route.path === '/chat')

    expect(settings?.meta?.hideAppSidebar).toBe(true)
    expect(chat?.meta?.hideAppSidebar).toBeUndefined()
  })

  it('does not expose Team as a settings category', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./views/SettingsView.vue', import.meta.url)),
      'utf8',
    )

    expect(source).not.toContain("key: 'team'")
    expect(source).not.toContain('TeamView')
  })

  it('does not expose MCP as a settings category', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./views/SettingsView.vue', import.meta.url)),
      'utf8',
    )

    expect(source).not.toContain("key: 'integrations'")
    expect(source).not.toContain('MCP / 集成')
    expect(source).not.toContain('McpView')
  })
})
