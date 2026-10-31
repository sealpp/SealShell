---
name: seal-e2e
description: 运行 SealShell 的浏览器界面、Rust 协议和 Windows Tauri/WebView2 端到端测试。涉及 SSH/SFTP、传输取消、转发、会话生命周期或真实桌面验证时使用。
---

# SealShell Windows 验证

产品是 Vue + Tauri 2 + Rust。本技能覆盖三层验证；浏览器 mock 通过不能代替原生协议和桌面测试。

```text
Playwright Chromium → 显式浏览器测试适配器 → Vue 交互
Rust tests → 原生 runtime → AsyncSSH / TCP / HTTP fixtures
Playwright CDP → Windows WebView2 → Tauri IPC → 同一原生 runtime
```

## 入口

从仓库根目录执行，使用原生 Windows，不依赖 WSL：

```text
python scripts/setup.py
python scripts/test.py unit
python scripts/test.py native
python scripts/test.py ui
python scripts/test.py desktop
python scripts/test.py build
python scripts/build.py
```

默认 `python scripts/test.py` 顺序执行全部检查。Python 只服务测试 fixture，由根目录 uv 环境管理；安装后的产品不依赖 Python、Node.js 或 Rust 工具链。setup 不安装 Rust/MSVC，应先准备这些开发依赖。使用已有浏览器缓存时可传 `--skip-browser`。

## 三层边界

- Vue 单测保留编码、目录、监测/进程策略、候选意图、保存快照、队列显示和退出保护。
- 浏览器 harness 显式导入 `shell/tests/native-mock.ts`。模拟凭据不是加密实现，密码保护由真实 DPAPI 测试验收。禁止为测试在产品中增加 localhost RPC 网关。
- Rust 测试使用真实本机文件和 AsyncSSH，验证初始 PTY 尺寸、exec、主机密钥、认证、文件往返、队列、取消、回滚、保留项以及转发 half-close。
- `shell/tests/desktop-e2e.mjs` 将调试应用编译到本次临时目录，用随机 Vite/CDP 端口和独立 SQLite/WebView2 目录启动，直接驱动真实桌面页面；日常开发应用运行时也可验证。覆盖连接、系统识别与图标保存、文件传输、编辑保存、监测和关闭确认；截图、日志留在系统临时目录。
- 发布安装包应另行验证内置资源和全新配置启动，开发服务器运行成功不能替代打包测试。未执行的 Win10 实机或另一台设备验收如实记录。

## Mock SSH

`mock-ssh-server.py` 提供密码认证、交互 PTY、采集 exec、SFTP v3、可选 direct-tcpip。
所有文件操作通过 `MOCK_SFTP_ROOT` 限定在测试目录。

- `MOCK_SSH_PASSWORD`：固定测试密码。
- `MOCK_SSH_STATE_PATH`：连接、命令、初始/最新 PTY 尺寸等可观测计数。
- `MOCK_SSH_REPORT_CWD=1`：普通 mock 上报目录。
- `MOCK_SSH_FORWARDING=1`：允许 direct-tcpip。
- `MOCK_SFTP_CONTROL_PATH`：测试控制 JSON，支持读写延迟、读取失败、最终 rename 失败、临时项删除失败。
- `MOCK_SYSTEM_CONTROL_PATH`：系统探测控制 JSON，`systemMode` 可选 ubuntu、macos、windows、unknown、denied、timeout、oversize；原生回归还验证失败或超时后的会话可用性及取消后不写回。
- `MOCK_SSH_BASH` / `MOCK_SSH_ZSH`：把实际 shell 接入测试；Git Bash/MSYS2 可在 Windows 使用。Bash 通过不能代替 zsh，mock 上报目录不能冒充实际 shell 验证。
- `SEAL_PYTHON`：覆盖测试解释器路径。

只在 fixture 注入失败，不为生产代码增加专用故障分支。临时项删除失败时必须验证准确保留路径，不能要求所有远端立即释放 Windows 文件锁。

桌面 runner 使用 `SEAL_E2E_BASH` 或 `SEAL_E2E_ZSH` 启用真实 shell 时，还验证本地历史提示：无历史不出现词库建议，已有相对路径原样显示为 history 来源，等待防抖周期后 SSH exec 计数不增加且没有 AI trace，采纳不执行。手工 Ctrl+U 清空行后，用空 Enter 并等待新的提示符再开始下一例；只发现屏幕上的旧提示符不足以证明输入观察器已恢复。

浏览器测试若缺少对应 Playwright Chromium，可使用已安装 Chrome：设置 `PLAYWRIGHT_CHANNEL=chrome` 后运行 UI 套件；不要删除其他版本的浏览器缓存。界面 harness 的历史由用例显式注入，产品没有默认命令词库。

## 纪律

1. 先完成源码修改，再运行共享该 checkout 的 Vite/浏览器测试；不要边验证边触发 HMR。
2. 不终止占用端口的用户服务。浏览器套件使用 9324，桌面 runner 使用随机端口；日常开发默认 8080。
3. 只清理本次启动的应用、Vite、SSH 和浏览器进程，等待它们退出。不要遗留占用端口的后台任务。
4. 应用数据、WebView profile、远端目录与状态文件必须隔离，不能改动用户真实凭据和主机。
5. Vite 扫描入口限定产品入口和编辑器；延迟依赖重新优化会刷新页面并破坏活动测试。测试模块不得被导入生产入口。
6. 断言资源结果和实际远端数据：尺寸比较 shell 的初始尺寸；半关闭验证 FIN 后还能收到回复；取消/回滚验证旧目标；AI 保留逐案例的生成意图和输出行为。
7. 桌面使用应用内关闭确认；浏览器 harness 的 beforeunload 仍应使用 Playwright dialog 处理。不可直接用原生 alert/confirm 代替产品交互。
