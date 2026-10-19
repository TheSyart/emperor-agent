import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreApi } from '../api/core-api'
import { loadModelConfig } from '../config/model-config'
import { localSecretKeyPath } from '../security/secret-sealer'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')
const apis: CoreApi[] = []

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('sealed model keys without the desktop main process (SEC-06)', () => {
  it('a Core started the way ACP starts it seals with the local key file (card 9)', async () => {
    const stateRoot = temp('emperor-acp-sealed-state-')
    // The same options serveEmperorAcpStdio passes: no host-supplied sealer.
    const api = await CoreApi.create({
      root: temp('emperor-acp-sealed-runtime-'),
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      appVersion: '0.0.0',
      enableFirstRunOnboarding: false,
      initializeMcp: false,
    })
    apis.push(api)
    expect(api.host.kept.secretSealer.available).toBe(true)

    const payload = await api.model.saveEntry({
      provider: 'openai',
      protocol: 'openai',
      modelId: 'gpt-5.2',
      apiBase: 'https://api.openai.com/v1',
      apiKey: 'sk-headless-acp-1234',
      contextWindowTokens: 128_000,
      maxTokens: 16_000,
    })
    expect(payload.models[0]!.apiKey).toBe('***1234')
    const disk = readFileSync(join(stateRoot, 'model_config.json'), 'utf8')
    expect(disk).not.toContain('sk-headless-acp')
    expect(disk).toContain('"apiKey": "el1:')
    expect(statSync(localSecretKeyPath(stateRoot)).mode & 0o777).toBe(0o600)
    // The running Core holds the opened key for its model routes.
    expect(api.host.kept.modelConfig.models[0]!.apiKey).toBe(
      'sk-headless-acp-1234',
    )
    const reopened = await loadModelConfig(stateRoot, {
      sealer: api.host.kept.secretSealer,
    })
    expect(reopened.models[0]!.apiKey).toBe('sk-headless-acp-1234')
  })
})
