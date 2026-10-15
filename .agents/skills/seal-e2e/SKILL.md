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

## 跨平台入口

从仓库根目录执行以下命令，Windows 使用原生 PowerShell，无需 WSL、Bash 或独立 protoc：

```text
python scripts/setup.py
python scripts/test.py node
python scripts/test.py unit
python scripts/test.py ui
python scripts/test.py files
python scripts/test.py ssh
python scripts/test.py proxy
```

`python scripts/test.py` 按顺序执行上述全部验证及生产构建。Python 环境由 uv 管理并锁定；
setup 使用清华 PyPI、npmmirror npm 和 Playwright 镜像，并保留其他项目的浏览器缓存。
`python scripts/dev.py` 同时启动日常开发的 SealNode 和 Vite，Ctrl+C（Windows 也支持 Ctrl+Break）后等待两者退出。

Python 测试入口检查所需端口，发生占用时直接报错，先由使用者关闭已有服务。
`files` 自行启动所需服务；`ssh` 由 Python 入口启动 Vite、JS runner 启动其余服务。
Playwright 的浏览器交互保留在 JS/TS 中，解释器路径自动区分 `.venv/Scripts/python.exe` 与 `.venv/bin/python`；
两条完整链路均可用 `SEAL_PYTHON` 覆盖解释器，并在成功、失败或启动失败后等待自启进程退出。

SealNode 不实现 SSH，也不保存主机或凭据业务数据。完整链路中的 SSH 协议由 PWA/WASM
Worker 执行；mock SSH 只属于测试依赖。

## 端口

1. PWA dev server 默认 `8080`，但被占用时 Vite 会 fallback 到更高端口。Node 只绑定
   loopback 且不做 Origin 校验，PWA 端口变化无需调整 Node 配置。
2. Node WebSocket 默认监听 `17373`，PWA transport 地址在 `shell/src/services/nodeClient.ts`
   中固定使用当前页面 hostname 和该端口。
3. 如果宿主机已有进程占用 `17373`，不要终止无关进程。Windows 先关闭自己启动的开发服务再测试；
   Linux 可将 PWA、mock SSH、SealNode 和 Playwright 放进同一个 network namespace，
   `unshare --net` 后先执行 `ip link set lo up`。

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

终端连接会先在已认证会话探测 Bash；mock 默认返回空版本，继续走普通交互 shell。
`run-e2e.js` 启用 OSC 7 目录报告并固定测试密码，覆盖双击、右键新建、Ctrl+反引号、补输密码、
认证重试与未知目录回退；目录包含中文、空格、单引号、百分号和命令替换符。必须同时验证 shell
实际目录和 PWA 报告目录，不能只断言复制了状态字段。

设置 `SEAL_E2E_BASH` 为本机 Bash 可执行文件后，SSH runner 会将真实 Bash 进程接入 mock SSH，
验证自动集成，而不是由 mock 伪造目录报告。Windows 可以使用 Git for Windows 的 Bash，无需 WSL：

```powershell
$env:SEAL_E2E_HOST = '127.0.0.2'
$env:SEAL_E2E_BASH = 'C:\path\to\Git\bin\bash.exe'
python scripts/test.py ssh
```

真实 Bash 的历史仅写入测试目录。Windows 收尾终止自启 mock SSH 的进程树，再删除 fixture，
防止子 Bash 仍占用工作目录；不终止其他开发实例。Bash 提示符钩子与退出状态另由单元测试验证。
AsyncSSH 的 PTY resize 会在 stdin 读取时抛出 `TerminalSizeChanged`，mock 必须消费后继续读取，
否则终端刚上线即断开，telemetry 也无法开始 exec；不要将其误判为 Node 转发故障。

## 选择器

`配对`、`登录`、`新建连接` 文字可能出现在菜单和弹窗中，必须限定作用域：

- Dialog 内容：`.workbench-dialog-content`
- 主操作按钮：`.workbench-dialog-content .workbench-dialog-button--primary`
- 取消按钮：`.workbench-dialog-button--default`
- 新建连接：在「会话」列表 `.conn-list` 空白处右键，再点击 `page.getByRole('menuitem', { name: '新建连接', exact: true })`；标题栏不提供新建按钮。测试列表内容较少时可直接右键列表中心，否则定位到底部空白处。
- 配对完成：等待 `page.getByRole('dialog', { name: '配对 Node', exact: true })` 隐藏。
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

- 失败截图和临时日志放在系统临时目录下的 `seal-e2e/`（Windows 通常为 `$env:TEMP\seal-e2e`）；
- `node_modules`、`.venv`、`shell/dist`、`shell/src/proto` 和 WASM 运行时复制文件不提交；
- 测试脚本、端口策略、选择器或链路行为变化时同步更新本 skill。

## 本机文件工作区

`run-files-e2e.js` 自行启动 Vite、SealNode 和 mock SSH，使用独立的本地/远端/下载目录和
临时配对文件，并在结束时关闭浏览器、等待子进程退出、清理 fixture。fixture 路径包含中文和空格。
Linux 端口被占用时可使用隔离网络：

```bash
unshare --net -- bash -c 'ip link set lo up; node .agents/skills/seal-e2e/run-files-e2e.js'
```

若 Playwright 自带浏览器未安装但系统有 Chrome，可设置 `PLAYWRIGHT_CHANNEL=chrome`；
两个 E2E runner 和现有 Playwright 配置均支持此变量。不要为了测试替换用户的运行中服务。

覆盖本地按钮分栏、右键独立标签、多窗格目标选择、整目录替换、空文件、超过一个传输块的
双向复制、拖拽保留源文件、同会话剪切、永久删除、本地编辑、完整远端文本读取，以及刷新后
关闭标签但记住本地目录。必须用第二块及之后的内容校验 SFTP seek，不能只测小文件。
刷新后发送快捷键前应等待 `nodeConnected`；`paired` 只表示读到了已保存身份，认证与快捷键初始化可能还未结束。
关闭分栏后，应等待剩余窗格重新填满文件区再记录宽度；DOM 中剩余两栏不表示 Dockview 布局已完成。

`shell/tests/file-navigation.spec.ts` 属于 `python scripts/test.py ui`：用延后连接的文件会话验证本地/远端
初始目录不变时上级操作立即可用、双击 `..`、上级按钮、Alt+Up、前进/后退历史、根目录禁用和会话移除后禁用。
此回归不需要启动 SealNode，不使用开发实例的配对或文件数据。

`shell/tests/transfer-status.spec.ts` 使用真实传输队列与可控完成/失败回调，验证状态栏预览、关闭详情后连续进度不重开、排队取消、失败重试、完成后的保留项警示、编码入口共存和减少动态效果。此 UI 回归不启动 Node，也不操作真实文件。

## 大文件、慢传输与取消

按需运行 `python scripts/test.py transfers`（不加入日常 `all`，避免每次执行大文件压力测试）。
默认验证 128 MiB；Windows 已有开发实例时使用独立回环地址：

```powershell
$env:SEAL_E2E_HOST = '127.0.0.2'
$env:SEAL_STRESS_MIB = '256'
$env:SEAL_STRESS_SLOW = '1'
python scripts/test.py transfers
```

`run-transfer-stress.js` 使用分块生成的随机数据，先测真实 libssh2/WASM 堆，再通过真实 Worker、
任务队列和 Node 执行上传、下载、远端到远端复制；三种方向均校验完整 SHA-256。
通过 mock 服务端的可控读写延迟让请求处于等待中，取消后应在 5 秒内结束且 Worker 数量回到基线；
最后所有 Worker 与远端句柄都必须归零。`SEAL_STRESS_SLOW=1` 另加超过一分钟的持续慢写入。

取消时远端可能仍在执行请求，Windows 文件锁会阻止立即删除临时文件；测试应验证取消记录包含准确的
保留路径，不能要求所有服务器都立即删除。测试待服务器释放句柄后清理自己的临时 fixture。
成功或失败均退出自启服务，样本保存在系统临时目录的 `seal-e2e/transfer-stress/`。
这里记录的 WASM 堆大小不是整个浏览器进程的工作集；不得把浏览器缓存或进程保留页当成仍存活的传输 Worker。

## 前置代理与回环隔离

`python scripts/test.py proxy` 启动独立的 mock HTTP CONNECT / SOCKS5、mock SSH、SealNode 和 Vite。
覆盖无认证/用户名密码、代理侧域名解析、分片响应与 SSH banner 粘连、拒绝认证与目标、禁止回退直连、
公共引用及直接填写凭据、终端/监控/SFTP/编辑器和跨块双向传输、旧会话快照及刷新持久化。
代理 fixture 只允许连接本次 mock SSH，状态文件不记录密码；临时配对文件和所有自启进程在结束时清理。

Windows 若已有开发实例占用 `127.0.0.1:17373`，可以使用独立回环地址，不必停止该实例：

```powershell
$env:SEAL_E2E_HOST = '127.0.0.2'
python scripts/test.py
```

仅 `files`、`transfers`、`ssh`、`proxy` 的 PWA/Node 采用该地址；目标 fixture 仍在本机。入口会检查指定地址的端口。
Vite 对 `127.0.0.2` 可能输出 `Network`，启动检测须同时接受 `Local` 和 `Network`。
测试后确认自启地址的 8081/17373 均已释放，不终止原有 127.0.0.1 开发服务。

自动保存的 UI 验收应等待状态提交或窗口实际关闭后刷新；验证遮罩关闭使用遮罩 locator 的点击，
让 Playwright 等待元素稳定，不用绕过 actionability 的坐标点击冒充就绪状态。

单独协议验证可运行 `python scripts/test.py node`，覆盖未认证拒绝、
句柄隔离、目录分页、块大小与断开回收。Windows/macOS 的路径单元测试不替代相应 OS 实机验证。

不要同时运行共享同一 checkout 的多个 Vite/browser 验证或修改 Worker：配置会复制 WASM 资源，
HMR 可能干扰另一个测试中的活动会话。运行验证前完成源码修改，再按序执行。
