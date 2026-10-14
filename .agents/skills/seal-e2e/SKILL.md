---
name: seal-e2e
description: 运行和维护 SealShell 端到端测试（PWA/WASM 协议客户端 + SealNode transport + mock SSH）。当要写 E2E、调试 PWA telemetry polling、复现标签生命周期或完整验证 PWA ↔ Node ↔ 远端协议链路时使用。
---

# SealShell E2E 测试指南

## 测试栈

```text
Playwright (Chromium)
  ↓ HTTP/WebSocket
PWA (Vite/Vue + libssh2 WASM Workers)
  ↓ loopback WebSocket transport
SealNode (Python pairing + TCP/UDP relay)
  ↓ TCP
mock SSH server (asyncssh)
```

SealNode 不实现 SSH，也不保存主机或凭据业务数据。完整链路中的 SSH 协议由 PWA/WASM
Worker 执行；mock SSH 只属于测试依赖。

## 端口

1. PWA dev server 默认 `8080`，但被占用时 Vite 会 fallback 到更高端口。Node 只绑定
   loopback 且不做 Origin 校验，PWA 端口变化无需调整 Node 配置。
2. Node WebSocket 默认监听 `17373`，PWA transport 地址在 `shell/src/services/nodeClient.ts`
   中固定使用当前页面 hostname 和该端口。
3. 如果宿主机已有进程占用 `17373`，不要终止无关进程。将 PWA、mock SSH、SealNode 和
   Playwright 放进同一个 network namespace；`unshare --net` 后先执行 `ip link set lo up`。

示例：

```bash
unshare --net -- bash -lc '
  ip link set lo up
  npm --prefix shell run dev -- --port 8081 --host 127.0.0.1 >/tmp/seal-e2e-vite.log 2>&1 &
  pwa_pid=$!
  trap "kill $pwa_pid 2>/dev/null || true" EXIT
  until curl -fsS http://127.0.0.1:8081 >/dev/null; do sleep 0.2; done
  PWA_URL=http://127.0.0.1:8081 node .agents/skills/seal-e2e/run-e2e.js
'
```

## Node 与配对

Node 启动后输出：

```text
Listening on ws://127.0.0.1:17373, pairing code: 123456
```

E2E 必须解析实际六位码，不要写死。测试必须将 `SEAL_TRUST_PATH` 指向临时文件，避免修改
开发实例的 `seal-trust.json` 和已配对设备。PWA vault 使用浏览器 profile key 自动解锁。

## mock SSH

`.agents/skills/seal-e2e/mock-ssh-server.py` 应覆盖：

- 密码认证；
- PWA libssh2 的交互式 PTY shell；
- `uname -s`；
- telemetry direct `channel_exec` 采样命令；
- `printf exec-ok` 和简单终端命令。
- direct exec 的探测/采样计数，验证连续采样、收起停止采样、再打开不重复 OS 探测。
- SFTP v3 subsystem，覆盖目录、读写、rename、递归删除和符号链接；`MOCK_SFTP_ROOT` 是服务端 chroot，文件操作仅发生在测试目录。

交互式 shell 必须保持存活。PWA telemetry 使用独立 libssh2 Worker 的 direct `channel_exec`，
不依赖 shell marker，也不复用控制连接。
AsyncSSH 的 PTY resize 会在 stdin 读取时抛出 `TerminalSizeChanged`，mock 必须消费后继续读取，
否则终端刚上线即断开，telemetry 也无法开始 exec；不要将其误判为 Node 转发故障。

## 选择器

`配对`、`登录`、`新建连接` 文字可能同时出现在侧边栏和弹窗中，必须限定作用域：

- Dialog 内容：`.workbench-dialog-content`
- 主操作按钮：`.workbench-dialog-content .workbench-dialog-button--primary`
- 取消按钮：`.workbench-dialog-button--default`
- 新建连接：`.new-btn`
- 登录按钮：`page.getByRole('button', { name: '登录' })`
- 确认按钮（新建/编辑主机弹窗）：`page.getByRole('button', { name: '确认' })`
- 记住密码勾选框：`input[type="checkbox"]`
- 密码输入：`input[type="password"]`
- 主机名称/地址：`#host-name`、`#host-address`；名称必填，地址 placeholder 不是 `address`。
- 主机指纹接受：`#host-key-accept`

## 遥测验收

监控默认收起，测试须先点击“系统监控”再等待采样，不能依赖旧版的默认展开行为。
当前 exec 每次创建独立 Worker 连接，测试不得断言旧后台 shell 的固定复用数量。成功采样时：

- 有 4 个 `[data-metric-value]` 且不包含 `--`；
- 有 3 个 `[data-metric-kind="gauge"] .metric-gauge-chart`；
- 有 `[data-metric-id="process.count"][data-metric-kind="stat"]`。

当前仪表盘使用 CSS gauge，不依赖 canvas。面板关闭、标签切换或 session 断开时必须停止
polling；刷新后 host profile、凭据和设备身份保留，但活动 tab/session 不恢复；刷新后重新连接
应自动读取已保存凭据且不打开密码对话框。

## PWA WASM 资源

Vite 配置会从已锁定的 npm 依赖复制以下运行时资源到开发/构建 public 目录：

- `libssh2.wasm`

这些生成文件不提交。修改 `ws.ts`、`nodeClient.ts`、`ssh.ts`、Worker 或 Vite 配置后，
刷新页面或重启 dev server 再跑 E2E，避免 HMR 使用旧的 WASM/模块状态。

## 文件卫生

- 失败截图和临时日志放在 `/tmp/seal-e2e/`；
- `node_modules`、`.venv`、`shell/dist`、`shell/src/proto` 和 WASM 运行时复制文件不提交；
- 测试脚本、端口策略、选择器或链路行为变化时同步更新本 skill。

## 本机文件工作区

`run-files-e2e.js` 自行启动 Vite、SealNode 和 mock SSH，使用独立的本地/远端/下载目录和
临时配对文件，并在结束时关闭浏览器、等待子进程退出、清理 fixture。端口被占用时使用隔离网络：

```bash
unshare --net -- bash -c 'ip link set lo up; node .agents/skills/seal-e2e/run-files-e2e.js'
```

若 Playwright 自带浏览器未安装但系统有 Chrome，可设置 `PLAYWRIGHT_CHANNEL=chrome`；
两个 E2E runner 和现有 Playwright 配置均支持此变量。不要为了测试替换用户的运行中服务。

覆盖本地按钮分栏、右键独立标签、多窗格目标选择、整目录替换、空文件、超过一个传输块的
双向复制、拖拽保留源文件、同会话剪切、永久删除、本地编辑、完整远端文本读取，以及刷新后
关闭标签但记住本地目录。必须用第二块及之后的内容校验 SFTP seek，不能只测小文件。
刷新后发送快捷键前应等待 `nodeConnected`；`paired` 只表示读到了已保存身份，认证与快捷键初始化可能还未结束。

单独协议验证可运行 `./node/.venv/bin/python -m unittest discover -s node/tests -v`，覆盖未认证拒绝、
句柄隔离、目录分页、块大小与断开回收。Windows/macOS 的路径单元测试不替代相应 OS 实机验证。

不要同时运行共享同一 checkout 的多个 Vite/browser 验证或修改 Worker：配置会复制 WASM 资源，
HMR 可能干扰另一个测试中的活动会话。运行验证前完成源码修改，再按序执行。
