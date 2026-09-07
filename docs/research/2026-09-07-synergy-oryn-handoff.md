# Synergy Oryn 开发交接 Prompt

本文是一份开发任务指令。配套的 [实施 proposal](../decisions/proposed/architecture/2026-09-07-synergy-oryn.md) 拥有实现规格，[研究报告](2026-09-07-maintenance-automation-proposal.md) 提供源码与外部案例依据。三份文件目前是交接材料，不假定已经存在于远端 Oryn；跨环境交接时一起提供，并放到 Oryn checkout 的对应相对路径。

以下内容可以直接作为开发者或 coding agent 的任务 prompt。

```text
请实现 Synergy Oryn，并在完成验证后将代码推送到 yzxoi/synergy-oryn 的 topic branch，创建针对 dev 的 PR，交给人类审阅合并。这是实际开发任务，不要只返回分析、计划、伪代码或空壳工具。

先完整阅读随任务提供的文件：
1. docs/decisions/proposed/architecture/2026-09-07-synergy-oryn.md
2. docs/research/2026-09-07-maintenance-automation-proposal.md
3. 本文件 docs/research/2026-09-07-synergy-oryn-handoff.md

目标仓库：https://github.com/yzxoi/synergy-oryn
开发基线：dev；proposal 核对的上游提交是 81d568a8b4a0378d8b52cb4f4c8eee2ac17baab3。
若 dev 已更新，先比对受影响源码再调整实现；不要回退、覆盖或强推现有工作。交接文件不在远端时，从附件复制对应三份文件，保留当前 checkout 其他人的修改。

工作环境与 Git：
- 使用 Oryn 的独立 clone 或 task-owned worktree；先检查 status、branch、worktree 和 remotes，确认 origin 是 yzxoi/synergy-oryn。不要在原 SII-Holos/synergy checkout 修改 remote 或切换共享分支。
- 分支使用 codex/oryn-implementation 或清晰的 codex/oryn-* topic 分支。允许完成本任务所需的本地提交、向 Oryn topic branch push，以及创建/更新本任务 PR；不允许向 SII-Holos/synergy 推送，不直接推 dev/main，不 force push、不绕过 hooks、不 merge、不 release。
- Agent 创建的 commit 使用 conventional type，并保留 footer：Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>。
- 不改动或重启承载当前工作的 Synergy/Oryn 实例。运行测试实例时用独立 home、工作目录和显式不同端口；不复制生产凭据到测试进程。

产品目标：
- QA 在飞书回答问题、集中澄清和接收全部类型反馈。工程问题自动流向 GitHub issue、复现、编码、独立验证、review 和 PR；无法复现/缺环境/需产品决策时转人工。
- 用户只收到答案、必要询问、需人工或有用结果；不转发工具调用、推理、子代理日志和反复进度。
- 使用一个 Synergy runtime、多个 Agent 定义和独立 Session，复用 Boss、SessionInbox、worker pool、ToolScheduler、Scope/Worktree 和 Library。不新建 coordinator 服务、第二套执行队列/数据库，也不拆 QA/GitHub 两个内核。
- 同一个 Agent 定义可以处理多个并行 Session。每个 Case 一个工程 Boss root；每个编码候选一个独占写入 worktree；验证和 review 使用新 Session 与冻结候选。
- Agent 是 oryn、oryn-work、oryn-repro、oryn-code、oryn-review。按 proposal 实现 mode、hidden/visibleTo、模型角色、工具矩阵和 Host 授权，不仅靠 prompt 限制权限。
- Linux VPS 无公网 IP、不能 Docker。复用飞书长连接与 GitHub 出站 API；隔离条件不足时转获准 VM/人工，不用 full_access 或裸机不可信执行兜底。
- 所有合并由人类执行。自动 review 通过只表示可交人类审阅，不代表批准合并或已经发布。

实现方法：
- 阅读根和所属 package 的 AGENTS.md，以及 architecture、add-agent、add-tool、change-channel-runtime、change-persistence、change-execution-boundaries、integrate-llm、testing-guide、develop-synergy、git-guide 等适用 Skill。遵循最近的架构 owner，不能照搬过时示例。
- 按 proposal P0–P6 顺序完成。新行为先写失败的行为测试，再实现；所有 test 放 owning package 的 test/ 中。不要以只完成 P0/P1、添加工具名或 prompt 为最终交付。
- 实现 Case/Source/Attempt/Assignment 的稳定绑定和恢复；执行状态复用 Session/Inbox，不复制成第二套 scheduler。模型报告、可信 RunReceipt 和外部 ActionReceipt 分离。
- 通过受控 Oryn 工具复用 BossService。派单绑定固定角色、输入、worktree 和版本；模型不能任意指定 agent、发送目标、repo、凭据或 override policy。
- 实现飞书按话题隔离、显式 reply intent/outbox；异步结果从不可变来源关联返回。不得仅打开账号级 Runtime Boss 就声称完成。
- 实现 GitHub Oryn 路由、可信身份授权、issue/PR 映射、受控发布、head/check/review 更新观察和 ambiguous 对账。不要让旧 github-channel-agent 同时执行同一个任务。
- 实现独立验证与 reviewer、finding 逐项复核、head/base/evidence/policy 版本校验、有限返工与人工接手。PR 改写自身 gate、作者自评 passed、伪造 marker/label 都不能取得发布资格。
- 适用条件通过后由受控 GitHub App 写 oryn/delivery 并 mark_ready；检查真正可运行并验证 App 身份后才加入 required checks。不要禁用已有分支保护来完成 push/PR。
- 学习先完成带证据和失效条件的 verified Memory。自动 Experience reward 只有在幂等回执完善后才能启用，不伪造 child/synthetic 用户消息。
- 补齐 first-party tool 的 taxonomy/UI 注册、必要的 API/OpenAPI/SDK、配置生成、迁移、Case 最小界面、部署/preflight/备份恢复与文档。保留许可证和上游来源。

验证与授权范围：
- 对照 proposal A01–A16 逐项验证并给 pass/fail/blocked 证据。执行受影响的测试、typecheck、quality:quick、文档/决策检查；API 生成需验证稳定。避免默认跑整个高成本矩阵，绝不绕过 hooks。
- 重点覆盖重复事件、创建/发布窗口崩溃、并发隔离、权限绕过、候选变化、作者自清 findings、超时对账、取消/人工接手，以及普通 Synergy 行为不回归。
- 允许向 Oryn 发布本任务的开发分支和 PR；这不授权向真实飞书群发测试消息、任意创建业务 issue、给生产 App 改配置或部署 VPS。
- 没有真实 App、测试 repo 或目标平台时，继续完成可本地验证的代码、网络边界 fixtures、配置与部署资料。真实 canary 明确标 blocked/未部署，列出最少环境依赖，不把 mock 当 live，不因缺凭据放弃其余实现。
- 未明确要求当前会话内拆子任务时，不自行创建用户可见的新任务；是否使用内部开发子代理遵循当前执行环境的规则。

完成后交付：
1. 实际可运行的代码及必要文档，而非只有 proposal。
2. 角色/工具/源码实现与 proposal 的对应说明，任何偏差的依据。
3. 每项重要测试、验收结果和仍需环境验证的内容；没有运行的检查明确注明。
4. 安装/配置、无 Docker 部署、启动与恢复说明，以及不带秘密的示例。
5. commit、topic branch、push 结果和针对 dev 的 PR 链接；PR 正文包含问题、实现、验证、风险及待人工事项。
6. 明确没有自动合并、发布或触碰运行中的实例。

PR 正文和提交不含本地绝对路径、Session/Scope ID、私有 endpoint、真实群消息、凭据或原始私有日志。阶段性提交可以拆分，但最后请把本次完成范围收敛成可审阅的交付；不要在没有实际运行依据时宣称全部通过或已经上线。
```

开发者若发现 proposal 的 API/路径与新基线不同，可以选择符合当前 owner 的更短实现，须保留授权、隔离、证据、恢复和人类合并这些行为约束；把偏差和新证据写回设计记录，不能静默削弱验收条件。
