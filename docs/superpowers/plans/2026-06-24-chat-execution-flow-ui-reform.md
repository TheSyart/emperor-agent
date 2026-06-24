# Chat Execution Flow UI Reform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Chat 回复从线性卡片堆叠改造成更接近 Claude Code 的紧凑执行叙事流，并去掉 Chat 内用户输入与 Agent 回复生成时的蓝色框。

**Architecture:** 本阶段只做前端体验 v1，不改后端 ExecutionRun 协议。通过 `AssistantMessage.segments` 派生展示投影，把连续文本合并为 prose block，把连续工具合并为 tool group，再用 CSS 将 Chat 内 focus/streaming 强调改成透明或中性色。

**Tech Stack:** Vue 3、TypeScript、Vitest、Electron Vite、现有 runtime WebSocket 事件与 `AssistantSegment / ToolSegment / ThoughtSegment` 类型。

---

## File Structure

- `desktop/src/renderer/src/components/chat/assistantFlowProjection.ts`：纯函数投影层，把 raw assistant segments 转为 UI blocks。
- `desktop/src/renderer/src/components/chat/assistantFlowProjection.test.ts`：覆盖投影规则的 Vitest 单测。
- `desktop/src/renderer/src/components/chat/ToolGroup.vue`：连续工具批次的一行摘要与可展开详情。
- `desktop/src/renderer/src/components/chat/AssistantFlow.vue`：从 raw segment 渲染切换为 flow block 渲染。
- `desktop/src/renderer/src/styles/chat.css`：去掉用户气泡强调色和 streaming 文本蓝框。
- `desktop/src/renderer/src/styles/activity.css`：新增 tool group 样式，并去掉 composer textarea focus 蓝框。
- `desktop/src/renderer/src/styles/codex-v2.css`：最终覆盖层，确保 Codex v2 主题不重新引入蓝色框。

## Tasks

### Task 1：Assistant Flow Projection

- [x] 新增 `assistantFlowProjection.test.ts`。
- [x] 覆盖连续文本合并、连续工具合并、running 状态、error 优先级、fallback todos、ask/plan 独立、短 thought 过滤。
- [x] 新增 `assistantFlowProjection.ts`。
- [x] 实现 `projectAssistantFlow(message)`。
- [x] 运行 `npm run test -- assistantFlowProjection`，确认 7 个测试通过。

### Task 2：Tool Group UI

- [x] 新增 `ToolGroup.vue`。
- [x] 展示工具批次标题、状态、Agent 数、耗时和当前执行摘要。
- [x] running/error/todos/subagents 默认展开。
- [x] 展开后复用 `ToolEvent.vue`，保留现有工具详情能力。
- [x] 修改 `AssistantFlow.vue` 使用 `projectAssistantFlow()` 渲染 blocks。
- [x] 运行 `npm run typecheck`，确认 Vue/TypeScript 类型通过。

### Task 3：Chat 内去蓝框与透明化

- [x] `.timeline-node.text-node.streaming` 不再使用 accent 蓝色 border。
- [x] `.timeline-node.text-node` 背景和边框保持透明。
- [x] `.bubble.user` 改为透明或近透明，不使用蓝色强调背景。
- [x] `.composer textarea:focus` 与 `.composer textarea:focus-visible` 不显示蓝色 border、outline、box-shadow。
- [x] `.composer:focus-within` 仅使用中性色边框反馈。

### Task 4：Verification

- [x] 运行 `npm run test -- assistantFlowProjection`。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 打开 Chat 页面，确认工具组紧凑、回复文本无蓝框、composer 聚焦无蓝框、用户消息不再是蓝色强调框。

## Visual Acceptance

- 多个连续 `run_command/read_file` 工具显示为一个可展开工具组，而不是多个同级大卡片。
- 工具组摘要能看出执行状态、工具数量、Agent 数和耗时。
- Agent streaming prose 没有蓝色边框，只保留右下角小状态点。
- Composer 输入、聚焦、忙碌时不出现蓝色 focus 框。
- 用户消息气泡低干扰，背景透明或近透明。
- 1920×1080 和窄屏布局下文字不重叠、不溢出容器。

## Assumptions

- 本轮不实现后端 `ExecutionRun / ExecutionStep / ExecutionActivity`。
- 全应用其他表单和按钮保留键盘可访问 focus 样式；只去除 Chat 内蓝框。
- Claude Code 对齐重点是执行流信息架构，不复制其 React/Ink 代码。
