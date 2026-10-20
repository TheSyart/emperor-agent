import type { CoreOperationArgs, CoreOperationResult } from '@emperor/core/api'
import { invokeCore } from './backend'
export const listExecutorModels = (
  input: CoreOperationArgs<'executors.models'>[0],
) => invokeCore('executors.models', input)
export const listExecutors = () => invokeCore('executors.list')
export const configureExecutors = (
  input: CoreOperationArgs<'executors.configure'>[0],
) => invokeCore('executors.configure', input)
export const probeExecutor = (input: CoreOperationArgs<'executors.probe'>[0]) =>
  invokeCore('executors.probe', input)
export const getDelegation = (input: CoreOperationArgs<'delegations.get'>[0]) =>
  invokeCore('delegations.get', input)
export const getDelegationReceipt = (
  input: CoreOperationArgs<'delegations.receipt'>[0],
) => invokeCore('delegations.receipt', input)
export const sendDelegationMessage = (
  input: CoreOperationArgs<'delegations.send'>[0],
) => invokeCore('delegations.send', input)
export const interruptDelegation = (
  input: CoreOperationArgs<'delegations.interrupt'>[0],
) => invokeCore('delegations.interrupt', input)
export const recoverDelegation = (
  input: CoreOperationArgs<'delegations.recover'>[0],
) => invokeCore('delegations.recover', input)
export const collectDelegation = (
  input: CoreOperationArgs<'delegations.collect'>[0],
) => invokeCore('delegations.collect', input)
export const validateDelegation = (
  input: CoreOperationArgs<'delegations.validate'>[0],
) => invokeCore('delegations.validate', input)
export const integrateDelegation = (
  input: CoreOperationArgs<'delegations.integrate'>[0],
) => invokeCore('delegations.integrate', input)
/** 「标记为已结束」: end a run that has no outcome (AGT-04). */
export const abandonDelegation = (
  input: CoreOperationArgs<'delegations.abandon'>[0],
) => invokeCore('delegations.abandon', input)
/** The result card (AGT-06): 应用到项目 · 丢弃 · 撤销 · 查看差异. */
export const applyDelegationResult = (
  input: CoreOperationArgs<'delegations.apply'>[0],
) => invokeCore('delegations.apply', input)
export const discardDelegationResult = (
  input: CoreOperationArgs<'delegations.discard'>[0],
) => invokeCore('delegations.discard', input)
export const undoDelegationResult = (
  input: CoreOperationArgs<'delegations.undo'>[0],
) => invokeCore('delegations.undo', input)
export const delegationResultDiff = (
  input: CoreOperationArgs<'delegations.diff'>[0],
) => invokeCore('delegations.diff', input)
export const closeDelegation = (
  input: CoreOperationArgs<'delegations.close'>[0],
) => invokeCore('delegations.close', input)
export type ExecutorList = CoreOperationResult<'executors.list'>
export type DelegationView = CoreOperationResult<'delegations.get'>
export type DelegationDelivery = CoreOperationResult<'delegations.receipt'>
