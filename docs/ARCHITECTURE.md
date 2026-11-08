# 架构说明

## 1. 运行时基线（第一阶段调查结论）

调查方式：`cordis_inspect_query`（Service / Event / Config / Tool / Slots）+ 阅读已安装包的
`lib/index.js` 与 README。以下结论全部来自实测，不是推测。

| 事实 | 值 |
| --- | --- |
| DSH 版本 | `0.2.1-rc.2`（`@deepseek-ai/dsh-desktop-runtime`） |
| Cordis | `4.0.5` |
| profile | `desktop`，`~/.dsh/profiles/desktop` |
| 插件形态 | bundle：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` `insert` 一行 |
| 工具注册 | `ctx.tools.register(definition)`；`definition = { name, description, parameters(JSON Schema), output:{schema,render}, execute(args, exec), isConcurrencySafe?, presentCall?, presentResult?, timeoutMs? }` |
| 工具执行上下文 | `exec.agent`（调用方 Agent）、`exec.signal`、`exec.callId`、`exec.arguments` |
| 子 Agent | `ctx.subagents.startActivation({provider,label,request,signal,delivery})` → `{childId, result, dispose}` |
| spawn 后端 | 默认 provider 名 `spawn`；capabilities = `depthLimit/outputSchema/agentOptions/agentPreset` 全支持 |
| 调用方取结果 | `delivery: 'caller'` → 直接 `await activation.result`，不产生父会话完成通知 |
| 用量 | 子会话 `assistant/message` 事件携带 `usage`；通过 `ctx.sessionQuery.readSession(childId)` 读取 |
| 提示段 | `ctx.systemPrompt.section({name,order,text})`；`getSectionOrder('TOOL_SUBAGENT')` 可取排序位 |
| 设置表单 | 导出 `Config`（schemastery）→ `settings.describe()` 投影成表单，`settings.update(ns, patch)` 写回 profile patch |
| 调用前审批 | `tools/pre-execute` waterfall 返回 `{kind:'ask', reason, displayReason}` → 宿主 `ctx.approval` |
| 日志 | `ctx.logger.info/warn` |
| UI 扩展点 | `settings.section`、`main`(keyed)、`conversation.input.dock` 等 Slot 均存在（本版本未使用，见限制） |

**未使用/刻意不用的接口**：`workflowEngine`（脚本编排，本插件用直接激活更可控）、`agentTeams`
（Team 语义与本模型的部门调度重叠）、`session.append`（禁止为插件新增事件类型）。

## 2. 分层与依赖

```
index.js (bundle 入口)
└── lib/index.js            插件装配：配置 → 状态目录 → 提示段 → 工具
    ├── config.js           纯函数：默认值/校验/归一化
    ├── schema.js           Config Schema（设置页表单）；依赖缺失时优雅降级
    ├── state.js            node:fs 持久化（state/audit/agents/overrides）
    └── tools.js            3 个 ToolDefinition
        └── runner.js       编排器（三省流程 + 六部切片）
            ├── classify.js 规则分级
            ├── plan.js     计划归一化 + DAG
            ├── prompts.js  全部提示词
            ├── agents.js   Subagent 桥
            │   └── usage.js  会话日志用量读取
            ├── budget.js   Token/成本/时间
            └── render.js   报告渲染
```

依赖方向严格单向：`tools → runner → 领域模块`。除 `agents.js`、`state.js`、`index.js` 外全部是纯函数，
因此 `test/unit.test.js` 可以直接 `node --test` 覆盖，不需要启动 Harness。

## 3. 数据流

```
tool(args, exec)
  → 归一化配置（行配置 ⊕ 运行期覆盖）
  → classifyTask（L0 直接返回）
  → 中书省：caller.subtasks 或 planner 子 Agent → normalizePlan → 依赖校验/拓扑分层
  → 门下省：规则审核 或 reviewer 子 Agent → APPROVED / REVISION_REQUIRED / REJECTED
       └─ REVISION_REQUIRED → planner 修订（≤2 轮）→ 再审核
  → 尚书省：nextBatch(依赖已完成的子任务, 并发上限) → startActivation(delivery:caller)
       ├─ 子任务成功 → 完成集合
       ├─ 失败 → 重试（≤maxRetries）→ 仍失败则依赖它的子任务标记 blocked
       └─ 预算/时间耗尽 → 停止新增，剩余标记 skipped
  → 独立质量审核：reviewer 子 Agent 对照用户原始要求 → PASS/FAIL
       └─ FAIL → fixer 子 Agent（≤maxReviewRounds）→ 复审
  → render.buildSummary → 工具结果 + 审计 + state.json
```

## 4. 任务等级与状态机

**分级（纯规则）**：长度、句段数、复杂信号词（+2）、中等信号词（+1/+2）、文件数（+1）、
简单信号（−1）、用户自定义关键词（+3）。`score ≥ complexityThreshold → L2`，`≥ l1Threshold → L1`，否则 L0。

**工作流状态**：`running → delivered | partial | needs-attention | rejected | failed | direct`

| 状态 | 含义 |
| --- | --- |
| `direct` | L0，未创建任何子 Agent |
| `delivered` | 全部子任务完成且质量审核 PASS |
| `needs-attention` | 有交付但质量审核 FAIL（返工轮数用尽） |
| `partial` | 部分子任务完成 |
| `rejected` | 门下省拒绝计划 |
| `failed` | 无可用交付（规划失败/无法启动子 Agent/异常） |

**子任务状态**：`pending → running → done | failed | blocked | skipped`

**部门状态**：`pending / running / done / failed / approved / rule-approved / approved-with-risk /
rejected / partial / passed / failed-review / skipped`，逐条写入审计流。

## 5. 失败与恢复策略

| 失败点 | 处理 |
| --- | --- |
| planner 无输出/输出非 JSON | 计划无效 → `failed`，记录原始输出片段 |
| 计划依赖不存在/成环 | `normalizePlan` 返回 issues，丢弃非法依赖；成环直接判无效 |
| 门下省 REVISION_REQUIRED | 最多 2 轮“修订→复审”，仍不通过则带风险执行并告警 |
| 门下省 REJECTED | 立即停止，状态 `rejected`，不执行任何子任务 |
| `startActivation` 被拒（容量/权限/后端缺失） | 记录 `ACTIVATION_REJECTED`，按重试策略处理 |
| 子 Agent `stopReason` 非 completed | 记 `INCOMPLETE`；空输出同样计失败 |
| 子任务失败 | 重试 ≤ `maxRetries`；仍失败 → 依赖者 `blocked`，其余继续 |
| 预算/时间耗尽 | 不再调度新子任务；已排队的标记 `skipped` 并记录原因 |
| 用户中断（工具 signal 取消） | 所有子 Agent 收到同一 signal 被取消；返回 `partial/failed` |
| 状态目录不可写 | 仅影响审计与历史，不影响调度（写失败只记 warn） |

所有异常最终被 `runWorkflow` 的 try/catch 兜住，转成 `status: failed` + `error`，不会把异常抛给 Agent 循环。

## 6. 复用原生能力清单

| 能力 | 复用的原生接口 | 未重复实现的部分 |
| --- | --- | --- |
| 子 Agent 生命周期 | `ctx.subagents.startActivation` | 不做进程/会话管理、不自己建 session |
| 并行/取消 | `AbortSignal` + 原生 activation | 不自建线程/队列 |
| 权限与沙箱 | 子 Agent 继承父 Agent 的权限根/审批策略 | 不扩权、不绕过审批 |
| 用量统计 | `ctx.sessionQuery.readSession` + `assistant/message.usage` | 不自己埋点、不估算 |
| 模型选择 | `request.agentOptions` / `agentPreset` | 不硬编码模型 |
| 会话日志 | 不写（插件数据落自有目录） | 不做会话轨迹系统 |
| 工具协议 | `ctx.tools.register` | 不自定义 RPC |
| 提示注入 | `ctx.systemPrompt.section` | 不改写其他插件提示 |

## 7. 关键设计取舍

1. **零依赖**：插件不 import 任何 `@deepseek-ai/*` 包。profile 安装的是链接目录，Node 会按真实路径
   解析依赖，因此引用 dsh 内部包会失败；代价是不能用 `defineTool`/`schemastery`，于是手写 JSON Schema
   与配置校验（已在 `test/unit.test.js` 覆盖）。
2. **`delivery: 'caller'`**：编排器需要 `await` 子结果并做审核/返工，父通知模式会打断父 Agent 的步骤。
3. **L1 不做模型级计划审核**：需求明确禁止“为形式上的审核重复调用模型”。
4. **用量读日志而非事件订阅**：实测根上下文监听 `session/event` 收不到子会话事件（用量恒为 0）；
   改读 `sessionQuery.readSession` 后一次 L1 实测得到 17,750 Token。
5. **返工新建 fixer**：避免依赖子 Agent 空闲时机与冷启动，行为确定、可测。
6. **预算软约束在审核环节**：见 README 限制 2，选择“宁可超一轮审核也不交付未经审核的成果”。
7. **`enable` 可逆优先于省 Token**：关闭时工具仍注册（拒绝执行），保证设置表单 / `sansheng_config`
   能把它再打开。真省 Schema 开销用 `remove_bundle`。
8. **审批闸门不劫持他人决策**：`tools/pre-execute` 监听器先 `await next()`，只在结果仍为 `allow` 时
   升级成 `ask`，因此不会覆盖其他插件的 `deny`/`cancel`；形态为 ask 时不跳过后续 guard
   （注册表在拿到 allow 后仍会跑 `guardReason`）。
9. **配置 Schema 与运行时校验双轨**：`schema.js` 只负责表单投影与范围提示，`config.js` 的归一化仍是
   权威校验（未知键告警、数值钳制、provider/model 成对约束），两者字段集合必须同步。
