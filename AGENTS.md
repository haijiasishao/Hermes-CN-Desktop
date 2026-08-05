# Hermes-CN-Desktop Android 移植

> 基于 Hermes-CN-Desktop v0.7.0（Tauri v2）改造为 Android 客户端
> 目标：仅保留 Remote 模式，连接已有的 Hermes Agent 后端

## 架构

```
┌─────────────────────────────┐
│   Android App (Tauri v2)   │
│  ┌───────────────────────┐  │
│  │  React WebView 前端   │  │  ← 适配移动端的 web/ 目录
│  │  (HTTP/WS 直连)       │  │
│  └──────────┬────────────┘  │
│             │               │
│  ┌──────────▼────────────┐  │
│  │  Rust 后端 (精简版)    │  │  ← 仅 connection.rs + 必要模块
│  │  Remote 模式专用       │  │
│  └───────────────────────┘  │
└─────────────┬───────────────┘
              │ HTTP + Token/OAuth
              ▼
     Hermes Dashboard (9119)
              │
              ▼
        Hermes Agent Core
```

- **仅 Remote 模式**：不托管本地内核，不管理子进程
- 连接方式：`HERMES_DESKTOP_REMOTE_URL` + `HERMES_DESKTOP_REMOTE_TOKEN` 或 `connection.json`
- 前后端通信：Tauri IPC（invoke/event）

## 工作区结构

```
/opt/data/workspace/hermes-android/
├── Hermes-CN-Desktop/          ← 源仓库（main，只读）
├── wt/desktop-android/         ← 工作树（feat/android-port，在此修改）
│   ├── src/                    ← Rust 后端
│   ├── web/                    ← React 前端
│   ├── Cargo.toml              ← 已改造（feature flags）
│   ├── tauri.conf.json         ← 已改造（Android 适配）
│   └── AGENTS.md               ← 本文件
└── builds/                     ← 构建产物
```

## 改造进度

### ✅ 已完成（P0 批）
- [x] 仓库克隆到工作区
- [x] 创建 git worktree `feat/android-port` 分支
- [x] 工作区目录结构
- [x] **Cargo.toml**：feature flag 化（desktop/android），桌面依赖 optional
- [x] **src/lib.rs**：模块级 `#[cfg(feature = "desktop")]` 守卫（tray/process/supervisor/desktop_control/coding_agents/prevent_sleep/update_stage）
- [x] **tauri.conf.json**：Android 适配（去固定窗口尺寸、CSP 放宽、bundle targets=apk、identifier 改 mobile）
- [x] **src/main.rs**：重写为 Android 入口（去掉托盘/单实例/Managed 内核，只走 Remote）
- [x] **src/commands/mod.rs**：桌面专属命令模块加 cfg 守卫

### ✅ 已完成（P1 批——编译修复）
- [x] **android_compat.rs**：dashboard/runtime/desktop_control/tray/PortLock 的 Android stub + desktop re-export（2026-08-05）
- [x] **bootstrap.rs**：cfg 守卫 + connect_local_backend 跨平台化
- [x] **state.rs**：terminate_owned_dashboard_tree/remove_ownership_marker_path 走 compat
- [x] **connection.rs**：restart_compat 模块 + Manager/runtime/desktop_ctrl 条件导入
- [x] **environment.rs**：RuntimeRecord stub 字段类型对齐桌面
- [x] 各 command 模块桌面引用修复（debug_bundle/profiles/log_export 等）
- [x] `cargo check --no-default-features` 与 `cargo check --features desktop` 双 feature 0 错误 0 警告

### ✅ 已完成（web/ 前端移动端适配——骨架级）
- [x] **useMediaQuery/useIsMobile** hook（720px 断点，2026-08-05）
- [x] **AppShell**：移动端 sidebar 变抽屉（overlay + backdrop 点击关闭）、导航后自动收起、data-mobile 驱动 CSS
- [x] **app-shell.module.css**：单列 grid（minmax(0,1fr)）、fixed 抽屉定位
- [x] **app-top-bar**：移动端隐藏品牌 meta/导航数字/搜索 kbd，横向滚动兜底
- [x] **app-status-bar**：移动端紧凑条（隐藏重启标签/错误文本）
- [x] Playwright 验证：375/390/720/721/768/1280 视口无横向溢出、抽屉视口内打开、桌面回归干净
- [x] typecheck + build:desktop 通过；app-shell 测试 23/23

### ✅ 已完成（web/ 前端深度适配）
- [x] **安全区**：--h-safe-* 变量 + topbar/statusbar/sidebar inset 适配（Android 刘海/手势导航）
- [x] **触摸**：44px 最小点击目标、momentum 滚动、tap-highlight 透明、touch-action
- [x] **聊天组件**：assistant-profile-card 紧凑卡片、subagent-panel 全屏抽屉、cli-delegation-card/stall-notice 移动布局
- [x] **detail 路由**：workArea 纵向堆叠、composer 全宽
- [x] 验证：typecheck/build 通过；布局断言 390/768/1280 OK；路由扫描 24/24 干净；测试 154/154

### 📋 待做
- [ ] **触摸交互**：长按菜单、下拉刷新、Composer 键盘弹出适配（visualViewport）
- [ ] 各设置页深度验证（有数据时的表格/表单）
- [ ] **tauri android init** + 首次 APK 构建 + 真机验证
- [ ] 构建环境配置（ARM 服务器 140.245.96.94 Docker）
- [ ] `tauri android init` 初始化
- [ ] 首次 APK 构建调试

## 条件编译约定

本项目的 Android 改造使用 **Cargo feature flags** 而非 `#[cfg(target_os = "android")]`：

| Feature | 含义 | 包含模块 |
|---------|------|---------|
| `desktop`（默认） | 桌面端完整功能 | process/, tray, supervisor, desktop_control, pty... |
| `android` | 移动端精简版 | connection (Remote), commands (精简), 前端 |

**规则**：
- 桌面端构建：`cargo build`（默认 feature = desktop）
- Android 构建：`tauri android build`（Tauri 自动选择 android feature）
- 新增模块默认加 `#[cfg(feature = "desktop")]`，除非明确需要跨平台

## 桌面专属命令模块（已 cfg 守卫）

以下 commands/ 子模块仅在 `desktop` feature 下编译：
- `browser_companion` — 浏览器伴生模式（需 hyper 本地服务器）
- `coding_agents` — 编程 Agent 检测（需桌面环境）
- `desktop_update` — 桌面端自更新
- `restart` — Dashboard 重启（需 managed runtime）
- `runtime_manager` — 内核管理（安装/更新/回滚）
- `terminal` — PTY 终端
- `yolo` — YOLO 模式（需 managed runtime）

以下 commands/ 子模块跨平台保留：
- `api_proxy`, `connection`, `connection_auth`, `ws_proxy` — Remote 模式核心
- `gateway`, `profiles`, `memory`, `ui_store` — 跨平台
- `backup`, `config_migration`, `debug_bundle`, `log_export`, `session_export` — 工具类
- `devtools`, `environment`, `file_dialogs`, `git`, `im_onboarding`, `notify`, `preview` — 待验证

## 构建环境

- **目标服务器**：140.245.96.94（ARM64，Ubuntu 24.04，Docker 29.4.0）
- **内存**：23GB | **磁盘**：145GB（可用116GB）
- **构建方式**：Docker 容器内安装 Android SDK/NDK + Rust 交叉编译
- **SSH**：`ssh root@140.245.96.94`（密钥认证）

## 关键决策记录

- 使用 feature flag 而非 `#[cfg(target_os)]`：便于在桌面端开发时随时验证编译
- 保留 `connection.rs` 全部代码（Remote 模式跨平台，零改动即可）
- 前端保留 React 但需适配移动端布局（CSS 响应式，非分开维护两套 UI）
- 不引入 Hermes-CN-Core 依赖（Android 只做 Remote 连接，不托管内核）

## 参考

- 技能：`hermes-desktop-remote-connection`（含 `references/tauri-android-porting.md`）
- Tauri v2 Android 文档：https://v2.tauri.app/start/prerequisites/#android