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
python scripts/test.py ports
```

`python scripts/test.py` 按顺序执行上述全部验证及生产构建。Python 环境由 uv 管理并锁定；
setup 使用清华 PyPI、npmmirror npm 和 Playwright 镜像，并保留其他项目的浏览器缓存。
`python scripts/dev.py` 同时启动日常开发的 SealNode 和 Vite，Ctrl+C（Windows 也支持 Ctrl+Break）后等待两者退出。

Python 测试入口检查所需端口，发生占用时直接报错，先由使用者关闭已有服务。
`files` 自行启动所需服务；`ssh` 由 Python 入口启动 Vite、JS runner 启动其余服务。
`ports` 自行启动隔离的 TCP fixture、SSH、Node 和 Vite。Windows 已有日常开发服务时使用
`$env:SEAL_E2E_HOST='127.0.0.2'`，不要终止用户在 127.0.0.1 的服务。
Playwright 的浏览器交互保留在 JS/TS 中，解释器路径自动区分 `.venv/Scripts/python.exe` 与 `.venv/bin/python`；
两条完整链路均可用 `SEAL_PYTHON` 覆盖解释器，并在成功、失败或启动失败后等待自启进程退出。

SealNode 不实现 SSH，也不保存主机或凭据业务数据。完整链路中的 SSH 协议由 PWA/WASM
Worker 执行；mock SSH 只属于测试依赖。

端口套件覆盖：注入身份/端点的独立 SDK 客户端（同连接 TCP 与文件查询）、真实 WASM
direct-tcpip、多连接大块传输、FIN 后回复、占用端口回退、发现默认不转发、菜单/当前终端
定位去重、隐藏持续发现与转发、Enter/blur/Escape、全局监听范围切换、手工即启用、取消
结束已有连接、勾选持久化、配置快照、失败红灯及无弹窗、刷新和资源回收。mock 的
`MOCK_PORTS_CONTROL_PATH` 用 JSON 端口数组控制发现列表，`MOCK_SSH_FORWARDING=1`
启用真实 direct-tcpip。成功/失败截图保存到系统临时目录 `seal-e2e/ports`。
修改本地 libssh2 vendor 导出时更新包版本/锁文件，并在套件冷启动时重新生成 Vite 依赖缓存。

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
- direct exec 的探测/采样及连接计数，验证独立连接连续采样、隐藏仍采样、重复打开不新增连接、关闭释放连接。
- SFTP v3 subsystem，覆盖目录、读写、rename、递归删除和符号链接；`MOCK_SFTP_ROOT` 是服务端 chroot，文件操作仅发生在测试目录。

交互式 shell 必须保持存活。PWA 监测每实例使用独立 libssh2 Worker 的 direct `channel_exec`；不申请交互 shell，
不依赖终端、shell marker 或控制连接。

终端连接会先在已认证会话探测 Bash/zsh；mock 默认返回空版本，继续走普通交互 shell。
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

真实 zsh 使用 `SEAL_E2E_ZSH`，Windows 可指向 MSYS2 的 `usr/bin/zsh.exe`；与 Bash 分开运行同一套
SSH 验证。zsh 的用户配置目录和启动临时目录都放在 fixture 内，不读取开发者的 zsh 配置。
该环境变量也启用原生 zsh 单元测试，验证配置加载顺序、ZDOTDIR 重定向、既有提示符/目录钩子、
命令退出状态、历史记录和正常/提前退出后的引导文件清理。POSIX 平台另测整个 shell 进程组收到
SIGHUP 时的清理；Windows 跳过该信号测试，需用真实 Linux 环境补验。

真实 shell 的历史仅写入测试目录。Windows 收尾终止自启 mock SSH 的进程树，再删除 fixture，
防止子 shell 仍占用工作目录；不终止其他开发实例。Bash 提示符钩子与退出状态另由单元测试验证。
AsyncSSH 的 PTY resize 会在 stdin 读取时抛出 `TerminalSizeChanged`，mock 必须消费后继续读取，
否则终端刚上线即断开，telemetry 也无法开始 exec；不要将其误判为 Node 转发故障。

## 真实 OpenSSH 目录继承

`python scripts/test.py ssh-real` 连接独立的真实 SSH 测试端点，自行启动和清理本机 Vite、SealNode
及临时配对存储。通过环境变量提供 `SEAL_E2E_SSH_HOST`、`SEAL_E2E_SSH_PORT`（默认 22）、
`SEAL_E2E_SSH_USER` 和 `SEAL_E2E_SSH_PASSWORD`；本机服务仍用 `SEAL_E2E_HOST` 指定回环地址。
不要对生产主机执行；测试会在远端 `/tmp/sealshell-directory-随机值` 创建目录，成功后删除。
失败时由独立 fixture 的所有者清理残留目录。

推荐在授权的 Docker 主机创建带 `--init` 的独立容器，安装 OpenSSH 和 zsh，将端口发布到宿主
loopback 后用 SSH 隧道访问。容器 sshd 设置 `LANG=C.UTF-8`，并为测试账号启用密码认证及对应
登录 shell；未配置 UTF-8 时，真实 zsh 行编辑器会将中文输入变成问号，pipe mock 不一定暴露此差异。

此套件实际点击双击、右键菜单和快捷键，覆盖缺少/错误凭据重试、源目录随后改变及未知目录回退。
每个副本都执行 `pwd -P` 并核对终端输出，不能仅凭应用中的目录字段判定成功。额外核对 fixture
配置文件校验和、关闭全部 SSH 连接后的临时引导目录；普通退出与 SSH PTY 挂断是不同的清理路径。

## 选择器

`shell/tests/workbench-theme.spec.ts` 使用实际工作台验证活动栏的内缩圆角伪元素、选中/悬停/键盘焦点及图标位置稳定、列表聚焦/失焦选择、菜单 Portal 与 Dockview 标签的主题，以及终端配色改变后外围保持独立。Codicons 检查包含本地字体与断网后首次打开弹窗；不配对真实 Node，不操作用户主机。配色或密度变更时同步相关 UI 套件的视觉断言，并运行生产构建及 `node shell/tests/editor-offline.mjs`，验证编辑器首次离线加载的主题和字体。

`shell/tests/command-suggestions.spec.ts` 使用真实 xterm、独立 IndexedDB 和可延迟的回显夹具验证本地命令提示；另用实际 `ShellTerminal` 组件接入受控会话输入/输出，确认悬浮列表、首字符触发、鼠标与直接上下键选择、选中后 Enter 只补入、session 与历史落盘。覆盖导航后继续输入/退格/Tab、Esc 关闭后远端上下键恢复、Right 临时收起后输入重触发、远端灰字接受与新输入回显交错、行内光标暂停后缀补入、Right/Tab/未选中 Enter 保留、受控远端灰字共存、断网词库、单字符历史、频率、连接隔离、刷新、密码无回显、IME/选择/焦点、备用屏幕、多行粘贴、并发计数与删除清理、中文跨软换行、窄窗格边缘翻转和 resize。此 UI 套件不启动 Node，不操作用户远端；截图保存在系统临时目录 `seal-e2e/command-suggestions/`，不能把受控 ANSI 回显通过解释为任意插件、自定义提示符或真实 SSH 的完整验收。

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

从会话条目或终端右键「打开性能监测」创建实例；状态栏「性能监测 N」只切换显示。
每实例拥有独立、持续的 SSH 连接，采集不申请 PTY/shell，不与终端共享连接。
`run-e2e.js` 验证无终端启动、双入口去重、同地址不同配置独立、隐藏继续采样、
配置编辑/删除不影响旧实例、关闭重开采用最新配置、关闭/刷新后连接归零。

成功采样有四个 `[data-metric-value]`（不含 `--`）、三个 gauge 及一个进程数量 stat。
宽面板四卡同行，窄面板按容器宽度换行。关闭实例才停止采样；隐藏、换类别和换终端均不停止。
`run-proxy-e2e.js` 还验证监测在代理配置修改及终端关闭后继续使用原代理连接。

使用同步 `waitForFunction` 检查页面已有状态；当前 Playwright 会把 async 谓词返回的 Promise
直接当成成功。需要动态导入时，在测试侧轮询 `page.evaluate` 的已解析结果。

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
文件标题栏覆盖首次新建、多个同配置标签时定位最早创建的标签、保留原目录及来源终端关闭后禁用；
终端右键仍须创建独立文件标签。`shell/tests/bottom-panel-actions.spec.ts` 另验证同配置多终端、
本地/异配置排除、关闭首个后的递补、配置删除边界，以及监测/端口/进程主动定位和去重。
刷新后发送快捷键前应等待 `nodeConnected`；`paired` 只表示读到了已保存身份，认证与快捷键初始化可能还未结束。
活动连接、传输、后台监控命令或未保存编辑会触发浏览器退出确认。有意刷新使用同目录的
`confirmReload(page)`，断言出现 `beforeunload` 并接受，不清空活动状态或禁用监听绕过。
取消关闭使用 `page.close({ runBeforeUnload: true })` 并 dismiss；必须先有真实用户点击。
取消刷新的测试通过页面内 `location.reload()` 触发，不等待 `page.reload()` 导航完成，
因为选择留下后该导航不会提交。独立 UI 回归见 `shell/tests/close-protection.spec.ts`。
关闭分栏后，应等待剩余窗格重新填满文件区再记录宽度；DOM 中剩余两栏不表示 Dockview 布局已完成。

`shell/tests/file-navigation.spec.ts` 属于 `python scripts/test.py ui`：用延后连接的文件会话验证本地/远端
初始目录不变时上级操作立即可用、双击 `..`、上级按钮、Alt+Up、前进/后退历史、根目录禁用和会话移除后禁用。
此回归不需要启动 SealNode，不使用开发实例的配对或文件数据。

`shell/tests/file-icons.spec.ts` 复用同一文件列表夹具，验证本地/远端彩色主题图标、格式说明、独立链接标记、选中保留配色与断网后的图标切换；图标渲染不得调用文件后端。主题资源由固定版本离线生成，生产构建应把包含内嵌图标的 CSS 纳入 PWA 预缓存。

`shell/tests/file-sorting.spec.ts` 验证四列表头整格点击、升序/降序/恢复默认三态、Enter/空格、调宽不排序、窗格独立状态和选中/失焦高亮。排序只重排已有数据；夹具计数验证不额外读目录，并延迟刷新，确认返回结果采用等待期间新选或已取消的排序。`processes.spec.ts` 与 `ports.spec.ts` 对应覆盖同一三态表头与指针/键盘调宽；进程恢复 CPU 默认顺序、保留选择详情、未知 CPU 始终在后，端口保留启用状态及正常行内编辑。

`shell/tests/transfer-status.spec.ts` 使用真实传输队列与可控完成/失败回调，验证状态栏预览、关闭详情后连续进度不重开、排队取消、失败重试、完成后的保留项警示、编码入口共存和减少动态效果。此 UI 回归不启动 Node，也不操作真实文件。

## Monaco 文件编辑器

`shell/tests/editor.spec.ts` 使用实际 Dockview 与内存文件后端，验证中文深色查找替换、行号/高亮/折叠、Alt+Z、Ctrl+S、BOM/换行符、失败保留、保存期间编辑、编码重开清空旧撤销、同路径隔离、移动/隐藏恢复和关闭释放模型。加载未完成就关闭时，不得留下孤儿模型。

查找栏 tooltip 回归覆盖普通窗口和 150% DPI 窄窗口：鼠标静止跨越多个移出延迟周期，检查同一提示节点持续存在、不与按钮重叠、按钮持续命中，并在原位置点击关闭。查找栏通过位移收起，关闭状态检查 `aria-hidden`，不能仅用 Playwright 的可见性判断。

生产离线检查：先在 shell 执行 `npm run build`，再运行 `node tests/editor-offline.mjs`。使用独立 9325 预览端口和新浏览器上下文，安装 PWA 缓存后断网，首次打开真实编辑面板，确认高亮、中文查找栏、CSS/图标字体和基础 Worker 已缓存；产物不应包含语言服务 Worker。测试自动关闭预览服务器。

Monaco 使用 EditContext 时，textarea 可能只是只读的 IME 辅助节点。端到端输入先点击 `.monaco-editor .view-lines`，再发送键盘事件；查找/替换输入使用可访问名称「查找」「替换」，不强制点击隐藏 textarea。

## 远端进程管理

shell/tests/processes.spec.ts 使用真实底部工作区和可控 exec 响应，覆盖 1500 行虚拟化、
双入口去重、窗格详情、多选/树、确认取消、部分失败和隐藏暂停/恢复。

完整链路按需执行 python scripts/test.py processes。先将 SEAL_PROCESS_DOCKER_HOST
设为已获授权且可免密 SSH 的 Docker 主机；本机服务可用 SEAL_E2E_HOST=127.0.0.2 隔离。
此项不加入默认 all，因为依赖外部 Docker 环境。可用 SEAL_PROCESS_DOCKER_IMAGE
指定带 apt 的 Linux 基础镜像；默认使用 Playwright Noble 镜像。

runner 创建唯一命名的临时容器，在其中安装 OpenSSH 并创建非 root 测试账户；只对该容器内
自行启动的父子进程、忽略 TERM 的进程和 root 所有的拒绝目标执行控制测试。不操作宿主进程。
本机 PWA/WASM 经真实 Node 和 SSH 隧道连接容器，验证 TERM/KILL、进程树去重、
启动身份变化、权限不足不弹密码框、隐藏暂停、恢复采集和关闭后的 SSH 回收。
真实 /proc 命令行同时校验带空格、换行、字面百分号转义和空参数，确保采集保留 NUL 参数边界，图标识别不依赖重新拆分显示文本。
确认框须等待 fresh snapshot 请求完成后再核对目标数量，不用 DOM 尚未挂载时的 count 作结果。
退出时删除容器、隧道、配对 fixture 和所有自启服务；截图保存在系统临时目录 seal-e2e/processes/。

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
