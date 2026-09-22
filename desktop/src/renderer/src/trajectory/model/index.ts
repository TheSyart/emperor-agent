// Trajectory model (M6): framework-free projection of raw session events
// into the trajectory ledger. The Vue view (M7) consumes these exports.
export * from './contract'
export * from './record'
export { TRAJECTORY_DEFINITIONS } from './definitions'
export {
  EMPTY_TRAJECTORY_SNAPSHOT,
  TrajectorySnapshotBuilder,
  trajectoryViewDefinition,
} from './snapshotBuilder'
export {
  TRAJECTORY_EXTENSIONS,
  TRAJECTORY_TARGET,
  createTrajectoryAssembler,
  trajectorySnapshotOf,
} from './extension'
export * from './layout'
export * from './requests'
export * from './ledger'
export * from './viewModel'
export * from './virtualRows'
export * from './timeline'
export { TrajectorySearchIndex } from './searchIndex'
export { extractMarkdownPlainText, trajectoryPreviewText } from './preview'
export * from './durationStore'
