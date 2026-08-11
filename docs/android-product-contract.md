# Hermes Agent Android Remote-only 产品验收合同

> 本文件是 Android 独立项目阶段 0 的行为基线与验收口径。它描述当前源码已经验证的能力、必须保留的行为和仍需真机证据的事项；不把单元测试结果替代为真机结论。
>
> 适用工作树：`feat/android-port`。本地 `AGENTS.md`、`.hermes/` 计划文件和凭据均不属于本合同的提交范围。

## 1. 产品边界

### 1.1 产品定位

Hermes Agent Android 客户端只连接已经部署的 Hermes Agent/Dashboard，不在手机上安装、启动、停止或升级 Hermes Core。当前主架构保持 Tauri v2 + Rust transport + React mobile UI + Android 原生能力。

### 1.2 必须保持的边界

- 生产连接为单一当前远程连接；不自动在主、备用服务器之间切换。
- Android 端的 HTTP、WebSocket、上传、下载和认证请求必须经过 Rust/Android 原生认证 transport，不由 WebView 直接绕过认证发送。
- token、Cookie、密码、用户名和完整服务器地址不得写入普通日志、诊断包或 UI 调试输出；日志只保留脱敏后的状态和错误类别。
- 不把桌面本地 runtime、终端、Git 工作树、桌面更新、备份导入导出等能力伪装成 Android Remote 能力。
- 涉及通知、后台、文件、语音和系统权限的结论必须有真机步骤、设备状态和 Debug 日志支撑。

## 2. P0 行为合同

| 能力 | 必须满足的行为 | 当前自动化证据 | 当前真机状态 |
| --- | --- | --- | --- |
| 单一远程连接 | 地址、认证方式、探测、测试、保存并连接、注销均围绕一个当前连接；不自动切换其他服务器 | `android-remote-regression.test.ts`、`settings-connection-*` 测试；单链接清理审计已通过 | 覆盖安装迁移、网络变化后的同址重连待真机确认 |
| 认证 transport | Android Remote 的 API/WS/上传/下载使用原生代理；不能退回 WebView 直连 | `transport.test.ts`、`android-remote-regression.test.ts`、IPC 审计 | 待在设备上核对登录、Cookie/token 和网络切换 |
| 新建会话与流式消息 | 能创建任务、发送消息、接收流式 assistant 内容、停止任务并显示错误 | Web 单测、Protocol 85/85 | 需覆盖真实 Hermes 服务端 |
| 历史会话 | 能打开、重命名、置顶、分叉、归档、删除和导出；历史行的三点菜单保留 44×44 触控区 | `recent-table.test.tsx`、历史相关回归测试 | 三点菜单已由用户确认可接受；覆盖安装待复测 |
| 前后台恢复 | 恢复顺序为 transport 重建 → REST 消息快照 → 本地状态收敛 → 必要时 `session.resume`；不持续显示陈旧“思考中” | `gateway-reconnect.test.ts`、`session-map.test.ts`、`chat.test.ts` | 必须用后台完成、失败、长任务三种场景真机确认 |
| Session 映射 | gateway 临时 ID 变化时迁移运行时消息和审批状态；失效映射不得让下一条消息继续发往旧 ID | `session-map.test.ts`、`chat.test.ts` | 待真机覆盖“恢复后继续发送”和服务端 `session not found` |
| 任务通知 | 后台且进程存活时，完成、失败、批准通知只投递一次；通知 IPC 失败不得永久污染去重状态 | `notifications.test.ts`、Android 通知集成测试、Android Remote 回归测试 | 权限、系统 channel、后台完成投递和 Debug trace 尚未完成真机闭环 |
| 普通文件下载 | 能识别 `sandbox:/` 绝对路径 Markdown 链接，经过原生下载桥保存到 Android 文件系统；拒绝相对路径 | `media-file-link.test.ts`、`message-text.test.tsx` | 待真机验证中文文件名、保存位置和失败重试 |
| 图片/文件上传 | 通过原生认证代理上传，显示失败状态且不泄漏本地路径 | transport 与消息组件测试 | Photo Picker/SAF 真实设备矩阵待执行 |
| 设置页 | 只保留 Android Remote 所需的连接、认证、通知、诊断和应用设置；不显示主备配置或社区二维码 | settings、route、IPC 静态回归测试；源码和资源搜索无二维码引用 | 需在新 APK 上确认窄屏布局 |
| 路由安全 | Android Remote 打开桌面本地能力路由时，进入明确的安全落点，不调用本地桌面 API | `android-remote-route-policy.test.ts`、`android-remote-regression.test.ts` | 需真机逐页点击确认没有空白页或死循环 |

## 3. P1/P2 边界

### 3.1 P1：移动工作台

- Profiles、Models、Skills、MCP、Soul、Cron、Kanban、Health、Analytics、Logs、Debug 等远程能力继续保留，但须按移动卡片、搜索、分组和安全操作重构。
- 通知点击应深链到正确会话；连接诊断页应能显示 REST、WS、认证、最后事件和最后恢复结果。
- Android 凭据最终迁移到 Keystore；迁移前不得扩大明文持久化范围。
- 文件选择、保存、覆盖、分享和导出统一使用 Android Photo Picker/SAF/Share Intent。

### 3.2 P2：明确暂缓

- 后端 Push/FCM、应用被系统杀死后的实时完成通知；在后端注册、签名和隐私方案完成前，不承诺该能力。
- 可选前台服务；只有在确认长任务存活是产品需求后再评估耗电和常驻通知代价。
- 用户手动选择的多服务器 Profile；不得重新引入自动主备故障切换。
- 手机本地终端、Git 工作树、Hermes Core 安装管理和桌面 runtime 管理。

## 4. 数据与安全合同

| 数据 | UI 可见范围 | 日志/诊断规则 | 持久化规则 |
| --- | --- | --- | --- |
| 服务器地址 | 连接设置和必要错误提示 | 可记录协议、主机类别和端口；诊断包须按产品规则脱敏 | 只保留当前连接配置和迁移所需字段 |
| token/Cookie/密码 | 不在普通 UI 和诊断列表中回显 | 禁止明文；错误仅记录类别、HTTP 状态和 request/trace 标识 | 进入 Android 安全存储；旧字段迁移后删除或忽略 |
| 用户名 | 登录表单可见 | 不写入普通日志 | 与认证配置同等保护 |
| 本地文件路径 | 文件选择/下载流程必要时短暂使用 | 不进入通知正文、普通日志和导出包 | 不把 `sandbox:` 路径直接交给 WebView 导航 |
| 通知结果 | Debug 可见 `focused/visible/delivered` 等布尔状态 | 必须脱敏并可关联 trace ID | 去重状态只短期保存，不保存正文机密 |

## 5. 自动化质量门禁

以下命令必须在提交前通过：

```text
pnpm test:unit
pnpm typecheck
node scripts/check-android-ipc.mjs
cargo fmt --all -- --check
git diff --check
```

当前工作树已实际通过：Protocol 85/85、Web 156 个测试文件 1448/1448、TypeScript/4px grid、Android IPC/Manifest/feature 审计、Rust fmt 和差异检查。以上结果只说明源码和契约测试通过，不等于通知、后台恢复或 SAF 已经完成真机验收。

## 6. 真机证据门禁

每次声称 P0 真机能力完成，必须记录：

1. APK 构建提交、Artifact、APK SHA-256；
2. 设备型号、Android 版本、应用版本；
3. 操作步骤、前后台/网络/权限状态；
4. 预期结果与实际结果；
5. Debug 日志中的脱敏状态（至少包括连接、恢复、通知的阶段和错误）；
6. 若失败，保留失败复现条件和下一步定位假设，不以静态测试“推定已修复”。

当前通知、后台恢复、Session 续发和文件保存仍处于“代码与自动化测试通过、真机证据待补”状态。