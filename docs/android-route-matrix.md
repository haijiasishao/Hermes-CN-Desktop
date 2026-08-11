# Android Remote-only 路由矩阵

> 本矩阵按当前 `web/src/app.tsx`、`web/src/lib/android-remote-route-policy.ts` 和 Android Remote 回归测试整理。它区分“当前代码能否命中路由”和“独立 Android 产品是否应继续保留”，避免把桌面残留路由误认为已完成的移动能力。

## 1. 矩阵口径

- **保留**：属于 Android Remote 产品核心或远程工作台，继续维护并移动化。
- **条件保留**：只有在服务端契约和移动交互完成后保留；当前可能通过安全落点或能力开关限制。
- **删除**：依赖手机本地 Hermes Core、桌面文件系统或桌面窗口能力，不作为 Android 产品路由。
- **重写**：保留业务价值，但需要新的 Android 页面、原生能力或移动信息架构。
- Android Remote 当前的安全落点为 `/health`，普通未匹配路径回到 `/`；`/im/*` 当前回到 `/`。

## 2. 主流程与 P0 路由

| 路径 | 当前实现 | 产品决策 | 阶段 0 验收要求 |
| --- | --- | --- | --- |
| `/` | `PanelRoute` 会话列表/新建入口 | 保留 | 新建、最近会话、网络状态和主要动作首屏可操作 |
| `/new` | 重定向到新任务入口 | 保留 | 与 `/` 的新建语义一致，不产生空历史 |
| `/tasks/:taskId` | `DetailRoute` 会话详情 | 保留 | 流式消息、停止、恢复、审批、附件、通知点击回跳 |
| `/history` | `HistoryRoute` | 保留 | 三点菜单保留；重命名、分叉、归档、删除、导出可用 |
| `/connection` | `AdvancedRoute` 的连接页 | 重写 | 单一地址、认证、探测、测试、保存、注销和错误阶段解释 |
| `/health` | `HealthRoute` | 保留 | 作为远程安全落点和连接诊断入口，不能依赖本地 runtime |
| `/debug` | `DebugRoute` | 重写 | 展示脱敏恢复轨迹、通知状态、IPC 错误和版本信息 |
| `/logs` | `LogsRoute` | 重写 | 分页、级别过滤、敏感字段脱敏，禁止一次加载全部日志 |

## 3. 远程工作台路由

| 路径 | 当前实现 | 产品决策 | 备注 |
| --- | --- | --- | --- |
| `/projects` | `ProjectsRoute` | 条件保留/重写 | 只展示服务端 workspace/project，不提供手机本地 Git 假能力 |
| `/projects/:workspacePath` | `ProjectDetailRoute` | 条件保留/重写 | 路径必须来自服务端标识，不得把本地绝对路径传给 WebView |
| `/kanban` | `KanbanRoute` | 保留/移动化 | 先只读和安全写操作，遵循服务端契约 |
| `/skills` | `SkillsRoute` | 保留/移动化 | 卡片、搜索、详情和安全启用操作 |
| `/models` | `ModelsRoute` | 保留/移动化 | 供应商和模型选择不能横向溢出窄屏 |
| `/voice` | `VoiceRoute` | 重写 | 录音权限、取消、失败和后台边界需原生验证 |
| `/mcp` | `McpRoute` | 保留/移动化 | 仅操作远程 MCP；敏感配置不得在日志回显 |
| `/profiles` | `ProfilesRoute` | 保留/移动化 | 明确切换 Profile 对连接、会话和凭据的影响 |
| `/profiles/new` | `ProfileBuilderRoute` | 保留/重写 | 不允许把本地路径或桌面 runtime 选项暴露出来 |
| `/soul` | `SoulRoute` | 保留/移动化 | 远程服务端能力，写操作需确认 |
| `/cron` | `CronRoute` | 保留/移动化 | 移动端列表、详情、启停和错误提示 |
| `/analytics` | `AnalyticsRoute` | 保留/移动化 | 分段加载，避免大表在手机一次渲染 |
| `/coding-agents` | `CodingAgentsRoute` | 条件保留/重写 | 仅保留服务端代理能力；本地 CLI 能力删除 |
| `/common` | `AdvancedRoute` | 重写为设置首页 | Android 设置分组和安全区优先 |
| `/notifications` | `AdvancedRoute` | 重写 | 权限、channel、系统设置入口和诊断状态 |
| `/config` | `AdvancedRoute` | 条件保留 | 只显示服务端允许的配置；避免把桌面环境变量当作移动设置 |
| `/theme` | `ThemeRoute` | 保留 | 深色/浅色、字体缩放和无障碍必须通过窄屏验证 |
| `/about` | 当前 Android Remote 导向 `/health` | 重写 | 建立 Android 关于页：版本、构建号、服务端版本、许可、隐私、诊断 |

## 4. 当前受限或删除候选路由

| 路径 | 当前 Android Remote 行为 | 产品决策 | 后续处理 |
| --- | --- | --- | --- |
| `/memory` | 导向 `/health` | 条件保留 | 只有服务端 API、认证 transport 和移动 UI 契约明确后恢复 |
| `/memconfig` | 导向 `/health` | 条件保留 | 同上；不得调用手机本地 OpenViking 配置假接口 |
| `/openviking` | 导向 `/health` | 条件保留 | 同上；优先服务端能力 |
| `/hindsight` | 导向 `/health` | 条件保留 | 同上 |
| `/console` | Android Remote 导向 `/health` | 删除/条件保留 | 仅在服务端定义远程控制 API 后重新设计 |
| `/kernel` | Android Remote 导向 `/health` | 删除 | 手机不运行 Hermes Core |
| `/env` | Android Remote 导向 `/health` | 删除 | 不暴露桌面本地环境管理 |
| `/backup` | 当前路由仍在应用路由表中 | 删除 | 删除页面、菜单入口、Bridge 和本地备份命令；如需迁移，提供一次性受控迁移逻辑 |
| `/config-migration` | 当前路由仍在应用路由表中 | 删除/一次性迁移 | 仅保留旧配置读取、校验和写回，不保留桌面迁移页面 |
| `/im/*` | Android Remote 导向 `/` | 删除/条件保留 | 只有服务端即时通信契约明确后重新定义 |
| `/advanced/*` | 进入高级路由后由策略逐页限制 | 重构 | 收敛为 Android 设置子页，不保留桌面高级菜单语义 |
| `*` | 导向 `/` | 保留 | 未知路径不显示空白页，不触发本地能力 |

## 5. Android Bridge 验收边界

### 5.1 当前已验证的核心调用类别

以下类别已有 Android Remote 回归测试或 IPC 审计入口：

- 连接配置：获取、保存、探测、测试、应用；
- 引导状态和运行时配置；
- API/外部请求、认证 HTTP、WebSocket transport；
- 文件上传、下载和必要的图片处理；
- 通知权限检查/申请和原生通知投递；
- 会话/消息相关的远程请求；
- Profile、诊断和 UI 状态等仍由服务端或 Android 允许的桥接能力支撑。

### 5.2 当前明确不应在 Android Remote 暴露的类别

- terminal、PTY 和外部终端；
- 本地 Git 工作树、仓库审查和本地 workspace 文件读写；
- managed/local runtime 安装、启动、停止、卸载、升级和回滚；
- 桌面更新、浏览器伴随窗口和桌面环境检查；
- 桌面备份/配置迁移 UI；
- YOLO、本地 IM onboarding 及只对桌面进程有意义的控制命令。

阶段 2 的目标不是继续增加 `unsupported` 白名单，而是逐页迁移后从类型、Bridge 和 Rust command 中真正删除无调用桌面能力。当前 IPC 审计仍报告 `explicit_android_unsupported=48`，因此阶段 2 尚未完成；这不是当前 P0 单链接、恢复、通知和文件修复的阻断项，但必须在 Android-only 收敛阶段处理。

## 6. 路由验收方法

每新增或删除一条路由，至少补充：

1. Android Remote 与桌面 shell 的策略测试；
2. 页面是否调用了受限 Bridge 的静态检查；
3. 360×800、390×844、430×932 三个窄屏视口的 DOM 宽度检查；
4. 返回手势、滚动、键盘和权限提示的真机步骤；
5. 若是删除路由，确认菜单、深链、通知点击和旧 APK 覆盖安装不会落入空白页。

阶段 0 的后续工作按“先 Bridge 白名单、再页面迁移、最后删除 Rust command 和依赖”的顺序执行，不直接按文件名批量删除。
