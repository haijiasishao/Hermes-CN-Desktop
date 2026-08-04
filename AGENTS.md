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

### 🔄 下一步（P1 批——编译修复）
- [ ] **bootstrap.rs**：cfg 守卫（引用了 crate::process）
- [ ] **state.rs**：检查对 process 的引用
- [ ] **connection.rs**：检查对 process 的引用
- [ ] **environment.rs**：检查对 process 的引用
- [ ] 各 command 模块内的桌面引用修复（api_proxy/gateway/debug_bundle/ws_proxy 等引用了 crate::process）
- [ ] `cargo check --no-default-features --features android` 首次编译验证

### 📋 待做
- [ ] **web/ 前端**：移动端适配（响应式布局、触摸交互）
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