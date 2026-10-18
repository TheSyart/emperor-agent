// Refreshes the bundled model catalog from https://models.dev/api.json
// (MIT). Run it through vite-node, which resolves core's TypeScript imports:
//
//   npm run models:sync                         # write snapshot + manifest when the data changed
//   npm run models:check                        # exit 1 when the committed snapshot is stale or edited
//   npm run models:sync -- --input api.json     # project a downloaded copy instead of fetching
//
// Output: packages/core/src/model/metadata/{models-dev.snapshot.json,manifest.json}.
// Review the printed per-provider changes and the overrides in
// metadata/overrides.ts before committing a refresh; see
// docs/design/model-metadata.md.
import { runModelMetadataSync } from '../packages/core/src/model/metadata/sync'

process.exit(await runModelMetadataSync(process.argv.slice(2)))
