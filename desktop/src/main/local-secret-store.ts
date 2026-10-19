/**
 * Emperor's own key for secrets at rest now lives in Core
 * (`packages/core/src/security/local-secret-store.ts`), so a run without
 * this process (ACP, headless) seals model keys and MCP tokens with the same
 * key file (SEC-06). Main keeps importing it from here.
 */
export {
  LocalSecretError,
  LocalSecretStore,
  type LocalSecretProblem,
  type LocalSecretStoreOptions,
} from '@emperor/core/host-capabilities'
