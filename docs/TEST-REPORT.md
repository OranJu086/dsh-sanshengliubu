# 测试报告

测试时间：2026-11-08 22:25–23:05（Asia/Shanghai）
环境：DeepSeek Harness `0.2.1-rc.2`（桌面版，profile `desktop`）、macOS 26.3、Node `v25.8.0`、模型 `deepseek-flash`
插件：`dsh-sanshengliubu` 1.0.0

所有工作流均为**真实执行**：真实 Subagent 激活、真实子会话、真实 Token 消耗。没有任何录制数据或静态演示。

---

## 1. 单元测试

`node --test test/*.test.js` → **34 tests / 7 suites / 34 pass / 0 fail**（约 110ms）

覆盖：复杂度分级、计划归一化与依赖校验（缺依赖/成环/截断/异常项）、拓扑分层与批次调度、
预算与价格解析、配置归一化与未知字段告警、宽松 JSON 提取、子会话用量求和、报告渲染。

其中一条是本次修复的**回归测试**：`never re-dispatches a subtask that already left pending`。

---

## 2. 集成测试（真实工作流）

| # | 测试要求 | 实测证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 简单任务不创建 Subagent | `ss-mw7xqnmo-ns0d60`（L0，auto）：`status=direct`，`tokens=0`，`subagentCalls=0`，耗时 1ms | ✅ |
| 2 | 中等任务正确分配子任务 | `ss-mw7xrewn-gb2ern`（L1）：1 个执行子 Agent，规则审核 + 质量审核 PASS，交付 322 字答案 | ✅ |
| 3 | 复杂任务经过三省工作流 | `ss-mw7xxlxq-mo66b3`（L2）：中书省规划 3 子任务 → 门下省 2 轮审核未过（用尽修订轮）→ 尚书省执行 → 质量审核 PASS，8 次子 Agent 调用，11m53s | ✅ |
| 4 | 依赖任务不错误并行 | 审计时间线严格串行：`14:49:42 t1 done → t2 start`、`14:50:35 t2 done → t3 start`；另有 `nextBatch` 单测 | ✅ |
| 5 | 审核不通过能返工 | `ss-mw7xvp15-4zwy94`（L1）：首轮质量审核 `FAIL` → fixer 返工 → 第二轮 `PASS`（`reworkRounds=1`） | ✅ |
| 6 | 达到最大重试次数停止 | 故障注入（`subagentProvider=does-not-exist`）：`ss-mw7yrk58-wsiedp` 恰好尝试 2 次（1+maxRetries）后判定失败，1ms 内结束，无死循环 | ✅（见 §4） |
| 7 | 预算超限正确处理 | `ss-mw7xxlxq-mo66b3`：中途记录 `停止新增任务：Token 预算已用尽 (163963/150000)`；最终 197.8k/150k | ⚠️ 软约束，见 §5 |
| 8 | 插件关闭不影响原有功能 | 关闭 bundle 后调用 `sansheng_status` 返回 `unknown tool "sansheng_status"`；会话其他功能正常；重新开启后工具恢复 | ✅ |
| 9 | 重启后配置正确恢复 | `sansheng_config set {taskBudget:123456,maxSubagents:2}` → 关闭/开启 bundle → `show` 仍为 `123456` / `2` → `reset` 恢复默认 | ✅ |
| 10 | 状态与历史持久化 | 反复重启后 `state.json` 仍保存 6 条历史（含失败与 L0），`audit.jsonl` 94 条事件，`agents.json` 记录角色成功率 | ✅ |
| 12 | 宿主能识别配置 Schema | `Config.listConfigs` 对 `include:sansheng-liubu` 的 `status` 由 `absent` 变为 `schema`，返回 21 个字段（含中文 description、default、min/max） | ✅ |
| 13 | 调用前审批闸门生效 | `requireApproval` 默认 true；一次 L1 探针调用在审计中留下 `approval/ask`（`task` 为探针文本），随后调用继续 → 闸门触发且由宿主审批通道放行 | ✅（本会话为自动应答，未出现人工点击） |
| 14 | 开关可逆、不锁死自己 | `sansheng_config set {enable:false}` → `sansheng_run` 返回“插件当前已关闭”；`status`/`config` 仍可用；`set {enable:true}` 后 L0 调用恢复正常 | ✅ |
| 11 | 交付物真实可运行 | L2 产物 `demo/wordfreq.mjs`、`demo/wordfreq.test.mjs`、`demo/README.md`；本报告作者独立复跑：CLI 输出 5 行正确结果，`node --test` **9/9 pass** | ✅ |

### 用例 3 细节（L2）

- 规划：3 个子任务，依赖 `t2←t1`、`t3←t1,t2`
- 门下省：2 轮审核均 `REVISION_REQUIRED`，第 1 轮后生成修订计划；修订轮用尽后按现有计划执行并标记
  `approved-with-risk` + 告警（不无限循环，也不静默忽略）
- 执行：严格串行（依赖决定），未出现越序并行
- 独立审核：PASS（评分 97），审核方自行复跑测试与哈希比对，指出 2 条 `low` 级问题（Node 18 未实测、
  非 UTF-8 输入未文档化）
- 用量：197,814 Token / 8 次子 Agent 调用 / 11m53s

### 用例 5 细节（返工）

首轮审核 `FAIL`，fixer 按审核意见重写后第二轮 `PASS`（评分 95，`reworkRounds=1`，总 1m04s）。
交付内容与「不超过 150 字」的约束一致。

---

## 3. 开发过程中发现并修复的缺陷

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| 工具输出 schema 类型不符 | 首个 L0 调用报 `value.reviewVerdict must be a string` | `buildValue` 用空串代替 `null` |
| `logger` 未解构 | L1 调用报 `logger is not defined` | `defineTools` 补解构 |
| 状态目录未展开 `~` | 默认目录变成相对路径 `/~/.dsh/...`，落盘静默失败 | 用 `os.homedir()` 组装 `$DSH_HOME` |
| Token 用量恒为 0 | 根上下文监听 `session/event` 收不到子会话事件 | 改为 `ctx.sessionQuery.readSession(childId)` 读取子会话日志，实测得到 17,750 Token |
| 子 Agent 调用次数统计偏小 | 只统计子任务尝试次数 | 改为统计真实 activation 次数（L2 实测 8 次） |
| 吏部统计漏记计划修订 | planner 只记首轮 | 修订调用同样记录 |

---

## 4. 崩溃事件（SIGABRT / V8 OOM）

**现象**：22:58:51 宿主进程崩溃，DSH 自动重启（Web GUI 端口由 59427 变为 61615）。
崩溃报告：`~/Library/Logs/DiagnosticReports/DeepSeek Harness-2026-11-08-225900.ips`，
`EXC_CRASH / SIGABRT`，主线程栈顶为 `node::OOMErrorHandler` → `abort()`。

**触发**：一次故障注入测试——把 `subagentProvider` 改成不存在的后端后调用 `sansheng_run`（L1）。

**根因（插件缺陷，非宿主缺陷）**：调度器用 `nextBatch()` 挑选下一批子任务，它只排除了
`completed` 与 `active`，**没有检查子任务自身状态**。子任务失败后状态变为 `failed` 但不在
`completed` 中，于是每一轮都被重新派发：

- 后端不存在 → `startActivation` 立即失败 → 不产生模型调用 → **预算永远不会耗尽**，预算/时间保护不生效；
- 循环在事件循环上无等待地反复执行，累积 Promise 与告警文本 → V8 堆耗尽 → `abort()`。

这同时解释了为什么 `audit.jsonl` 里没有这一次的 `workflow/start`（审计写入是异步的，被紧循环饿死）。

**修复**：

1. `nextBatch()` 跳过任何状态不是 `pending` 的子任务（根因修复）；
2. 调度循环增加安全上限 `子任务数 × (maxRetries+1) + 4`，达上限即停止并告警（纵深防御）；
3. 持久化时告警最多保留 40 条，避免任何异常路径下的无界增长；
4. 增加回归单测 `never re-dispatches a subtask that already left pending`。

**验证**：同样的故障注入在修复后 1ms 内以 `status=failed` 结束，恰好 2 次尝试，
输出「子 Agent 后端 "does-not-exist" 未注册（可用: spawn, fork）」，不再崩溃。

**结论**：崩溃由插件中的调度缺陷导致；DSH 核心未受影响，重启后插件与配置均正常恢复。
遗留启示见 §6。

---

## 5. 预算语义（实测结论）

`taskBudget` 是**调度软上限**：预算耗尽后不再派发新的子任务，但**独立质量审核仍会执行**
（否则等于把未验收的成果交付给用户）。因此实际用量可能超出预算约一轮审核的量：

- 预算 150,000 → 实际 197,814（超出 31.9%），其中超出部分主要来自最后一轮质量审核；
- 需求跟踪里已记录 `停止新增任务：Token 预算已用尽 (163963/150000)`，报告中用量行显示 `197.8k/150.0k`，
  不做任何修饰。

如需硬上限，可用 `skip_review: true` 或配合 `taskBudgetUsd` + `modelPrices` 控制成本；
后续迭代会把预算下沉到子任务级（见 README 后续迭代 4）。

---

## 6. 尚未覆盖 / 已知风险

1. **预算硬上限**：如上，审核阶段不受预算约束。
2. **成本路径**：仅单测覆盖价格解析；真实计费未验证（未配置 `modelPrices`，实测均为 `unpricedTokens`）。
3. **并发并行**：L2 用例的计划是纯串行 DAG，`parallelExecution` 的**并行分支**只在单测与代码层验证，
   未在真实工作流中触发（`maxActiveSubagents=8` 的容量上限也未触及）。
4. **`autoEscalation`**：仅保留配置位，未实现难度→模型映射（文档已声明）。
5. **子会话日志读取成本**：`readSession` 会读取子会话完整事件流，长任务的单次开销需继续观察。
6. **UI**：无独立面板，只有工具卡片与 `status` 查询；未做任何界面层验证。
7. **设置表单渲染未肉眼验证**：Schema 投影已证实（用例 12），但“设置页里长什么样、开关点下去是否立刻生效”
   需要浏览器控制，本会话无法验证；开关的**行为**已用 `sansheng_config` 等价路径验证（用例 14）。
8. **审批闸门在本会话是自动放行**：`approval/ask` 证明闸门触发，但“人是否真的会看到弹窗”取决于该会话的
   answerer；需要人工会话复核。
9. **崩溃可观测性**：插件内部异常会转成 `status=failed`，但**事件循环级死循环**无法被该保护捕获——
   这正是 §4 的教训，已用安全上限缓解，仍建议宿主侧增加工具调用超时。
