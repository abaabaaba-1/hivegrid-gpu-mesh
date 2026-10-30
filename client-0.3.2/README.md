# 蜂网 BeeNet 客户端

一个下载即用的桌面客户端：在本机开一个网页界面（`http://127.0.0.1:18650`，只监听本机），里面有聊天、代码助手、图像、视频，以及账户和"共享 GPU"。

## 它做什么，不做什么

- **应用**：都通过平台的公开 API，用你自己的账户付费。API 密钥只存在客户端里（`api.key`，仅你的系统账户可读），网页拿不到它。
- **共享 GPU**：第一次启动时有一页同意页，**默认勾选**"显卡空闲时把 GPU 借给共享网络"，取消勾选就什么都不会共享，之后随时可以在"共享 GPU"页开关。同意之前不下载引擎、不启动节点。共享时：
  - 只在显卡空闲时运行：显卡空闲满 5 分钟才开始；你的程序（游戏、渲染、自己的 AI）一用到显卡（占用到 20% 以上）就暂停，它再空闲满这么久才恢复。键盘和鼠标不作判断，节点自己的运行也不算；
  - 只主动连出去，不开入站端口，不读你的文件；
  - 下载 llama.cpp（固定版本，校验 sha256）、1.1 GB 的测速模型，以及平台分配的模型（校验 sha256，占用不超过设定的磁盘上限）；
  - 志愿者节点只收到"公开"级别的请求。
- **更新**：默认自动。客户端每 6 小时检查一次已签名的发布清单（Ed25519，公钥写在客户端里）；发现新版本后自动下载、核对签名和文件校验码，通过了就装好，下次打开客户端生效。账户页的“自动更新”开关可以关掉，关掉以后页面顶部只提示，由你点"更新"才安装。签名或校验码不对的版本，不论哪种方式都不会安装。Mac 版：清单里有签名公证过的 app 压缩包，下载并核对后，下次打开客户端时替换整个 BeeNet.app（旧的留到新版本启动后删除），然后自动重新打开。前提是 BeeNet 所在的文件夹能写（一般是“应用程序”）；把 BeeNet 从 dmg 里直接打开而没有拖进“应用程序”时，macOS 会只读地运行它，更新会提示“请移到应用程序”。0.2.8 及以前的 Mac 版要先手动装一次 dmg。
- **开机自启**：默认关闭；在账户页自己打开（只写你自己账户下的启动项，不需要管理员权限）。

## 安装

| 系统 | 安装包 | 说明 |
|---|---|---|
| Windows | `beenet-setup-<版本>.exe` | 双击安装，装到你账户下（`%LOCALAPPDATA%\BeeNet\app`），建开始菜单快捷方式，在"设置 > 应用"里登记，不需要管理员权限。`-silent` 静默安装；同一个文件复制为 `uninstall.exe` 留在安装目录，`-uninstall` 卸载（`-remove-data` 同时删密钥和设置）。已用北京网梯科技发展有限公司的证书签名。zip 里的 `install.ps1` 是另一种装法（`-DryRun` 先看它要做什么）。 |
| Linux（Debian、Ubuntu） | `beenet_<版本>_amd64.deb` | `sudo dpkg -i beenet_*.deb`：装到 `/opt/beenet`，`/usr/bin/beenet`，应用菜单里有"蜂网 BeeNet"；`sudo dpkg -r beenet` 卸载。 |
| Linux（其他） | zip 里的 `install.sh` | `sh install.sh`（先加 `--dry-run`）：装到 `~/.local/share/beenet`，不需要 root；`--uninstall` 卸载。 |
| macOS（Apple 芯片） | `BeeNet-<版本>-arm64.dmg`（里面是 `BeeNet.app` 和"应用程序"的快捷方式） | 在一台 Mac 上用 `mac-package.sh` 构建（`hdiutil`、`codesign`）。已在真机上验证能运行、能下载并运行 Metal 引擎；签名加公证一条命令：`NOTARIZE=1 sh mac-package.sh <版本> <二进制目录> <输出目录> <证书指纹>`，先公证并钉好 app、再用它打 dmg 并公证（`notarize.sh`；公证用 App Store Connect API 密钥，凭据在 Mac 的 `~/.beenet-notary.env`，不进仓库）。签名要在 Mac 的登录会话里跑，SSH 里钥匙串是锁的。0.2.3 起已签名并公证。 |

## 运行

```
beenet [-gateway https://beenet.whaty.org] [-listen 127.0.0.1:18650] [-data 目录] [-no-browser]
```

设置、密钥、下载的引擎和模型都在数据目录（Windows 是 `%APPDATA%\BeeNet`，Linux/macOS 是用户配置目录下的 `BeeNet`）；日志在 `client.log` 和 `node.log`。再次运行客户端，会直接打开已经在运行的那个的页面。

## 本地网页的安全

只监听回环地址；Host 头必须是回环地址（挡 DNS 重绑定）；API 调用要带 HttpOnly + SameSite=Strict 的会话 cookie；改变状态的调用还要带自定义头（跨站表单发不出来）；严格的内容安全策略（脚本和样式只来自客户端自己）；网页只能转发应用需要的几个平台接口（模型、聊天、图像、视频、账户、贡献），转发时由客户端加上密钥。

## 给本机其他程序用（本机接口）

账户页的“本机接口”打开后，Open WebUI、Cherry Studio、编辑器插件或你自己的脚本，可以把客户端当成 OpenAI 兼容服务：Base URL 填 `http://127.0.0.1:18650/v1`，API 密钥填页面上显示的令牌（`bn-local-…`）。默认关闭，只对本机开放；令牌能聊天、补全、画图、做视频，动不了账户，可以随时换新；平台密钥不会交给这些程序。默认端口 18650 避开了 Ollama、LM Studio、llama.cpp 等常见服务；如果它被别的程序占了，客户端会改用 18651 以后的空闲端口，页面上显示的地址就是实际地址。

### Ollama 兼容

很多软件只认 Ollama 的接口。本机接口开着时，客户端自己的端口上也有 Ollama 的 `/api/chat`、`/api/generate`、`/api/tags`、`/api/show`、`/api/ps`、`/api/version`、`/api/embed`（同一个令牌：`Authorization: Bearer bn-local-…`），请求翻译成蜂网的 OpenAI 接口，流式结果翻回一行一个 JSON。支持常用字段：`messages`、`images`（base64）、`tools` 和工具调用结果、`format`（`json` 或 JSON schema）、`options` 里的 temperature / top_p / seed / stop / num_predict；`keep_alive` 等忽略。`/api/embed` 要平台有嵌入模型才能用。

只认 Ollama 默认地址（`127.0.0.1:11434`）的软件，可以在账户页打开“Ollama 兼容端口”：客户端会先检查这台电脑上有没有 Ollama（已安装或正在运行）、11434 是否空闲，**有 Ollama 或端口被占就不开**，也绝不去结束别人的进程；开启之后如果装了 Ollama，会自动让出端口并关掉开关（每分钟检查一次）。这个端口和 Ollama 一样不要密钥，但只接受本机程序的请求，带浏览器 Origin 的一律拒绝。

### Claude Code 等 Anthropic 协议的软件

本机接口开着时，客户端端口上还有 `POST /v1/messages`（Anthropic 的消息接口，流式事件、工具调用、图片都支持；提示缓存、批处理、PDF、`count_tokens`、思考块不支持）。Claude Code：`ANTHROPIC_BASE_URL=http://127.0.0.1:18650`，`ANTHROPIC_AUTH_TOKEN=<令牌>`，`ANTHROPIC_API_KEY=` 留空，再 `claude --model <蜂网的模型名>`（`beenet connect claude` 会按你的系统把这几行打印出来）。令牌可以放在 `Authorization: Bearer` 或 `x-api-key` 里。模型要会调用工具才好用。

### 我的预设

账户页的“我的预设”：给“某个模型 + 一段系统提示 + 温度等几个参数”起个名字（对应 Ollama 的 Modelfile），保存在本机 `presets.json`，不上传。之后在聊天软件、编辑器插件、命令行里像别的模型一样按名字用：本机接口的 `/v1/models`、`/api/tags` 里会多出这个名字，`/v1/chat/completions`、`/api/chat`、`/api/generate`、`/v1/messages` 和 `beenet run <名字>` 都会换成基础模型，并把系统提示加在最前面；请求自己带的参数（比如 temperature）优先于预设。名字只能用字母、数字和 `. _ : -`，不能和基础模型同名，也不要和平台上的模型重名。`beenet presets` 列出已有的预设。

### 这台电脑能做什么

账户页的“这台电脑能做什么”：读出每张显卡（型号、显存、空闲、PCIe）、哪些卡能一起跑一个模型（NVLink 或同一个 NUMA 节点内的算一组）、每组能跑多大的模型（4B 到 405B 的参考尺寸，4 位量化、8k 上下文、速度不低于舒适下限）。只读，不改任何东西，接口 `GET /api/machine`。多张卡的机器是后面“客户端自己把多卡分给多个模型”的第一步；集成显卡（AMD/Intel，Windows 只报告 4 GB 的上限）按内存的四分之三估算并标明是估算。

### 多张显卡

有两张以上 NVIDIA 显卡时，共享时客户端为**每张卡各起一个节点代理**（`-devices N` 把它限定在自己的那张卡上，各有自己的身份密钥、名字、端口、日志和入网令牌），平台把它们当作同一台机器上的几个节点：每张卡各跑一个模型（同一个模型可以放在几张卡上，吞吐更高，一张卡出问题只损失一个副本），放不进一张卡的大模型由平台把几张卡拼成流水线。一张卡、非 NVIDIA 的显卡或混合厂商的机器，行为和以前完全一样（一个代理，不限设备）。`config.json` 里 `"gpu_split": "one"` 可以改回“一个代理管所有卡”。显卡被其他代理占用不会被当成你自己的程序在用（空闲才共享的判断把所有代理都算作“自己”）。

### 命令行

同一个程序在终端里也能用：`beenet models`（列出现在能用的模型）、`beenet run <模型>`（终端聊天，`/bye` 退出，`/clear` 清空；带上提问或从管道读入则回答一次就退出）、`beenet connect <claude|openwebui|continue|cursor|python>`（打印怎样接到蜂网）、`beenet key`（显示登录用的密钥）。需要先在客户端登录；用的是同一份设置，账户页里开着“经 Tor 访问”时命令行也走 Tor。`-data <目录>` 指定数据目录。

**没有桌面和浏览器的服务器**：`echo 你的API密钥 | beenet login`（密钥走标准输入，不进进程列表；账户在有浏览器的电脑上用客户端注册），`beenet share on --yes --always`（先显示“共享时会发生什么”的同意文本，加 `--yes` 表示读过并同意；`--always` 随时共享，不加则只在显卡空闲时共享；`--vram-gib N`、`--disk-gib N`、`--search`），`beenet share status`、`beenet share off`，Linux 上 `beenet service install` 把客户端装成开机自启的 systemd 用户服务（退出登录后继续运行还需要有人执行一次 `sudo loginctl enable-linger 用户名`）。客户端在运行时这些命令直接和它对话（本机 18650–18699 端口，用页面同样的会话和请求头），没运行时写下设置，下次启动生效。

### 经 Tor 访问

账户页的“经 Tor 访问”打开后，客户端发往平台的所有请求（页面的、上面“本机接口”给其他程序用的、检查更新的）都经本机的 Tor 代理（独立 Tor 默认 `127.0.0.1:9050`，Tor 浏览器 `127.0.0.1:9150`）到平台的洋葱服务，平台和中间的网络看不到这台电脑的地址。调用方（Open WebUI、编辑器插件、脚本）不用改任何东西，网络上别人和自己提供的 GPU 模型、图像、视频、联网搜索都照常可用。没找到 Tor 时请求直接失败，不会改走直连。经 Tor 会慢一些；有地区限制的模型（例如 H3）在这条路上不提供。代理地址只能是本机。

## 构建和发布

```
go run ./release genkey -out release.key          # 第一次：生成发布密钥（私钥自己保管，不进客户端）
python package.py --version 0.1.0 --pubkey <发布公钥> --sign release.key --base https://beenet.whaty.org/client/0.1.0/
go test ./...                                     # 单元测试
node browser-test.mjs <页面地址> <邀请码> [--share --always] [--no-video]   # 真浏览器端到端测试
# 发布：把各系统的文件、安装包、SHA256SUMS 放进发布文件夹，最后写 manifest.json；下载页由官网程序（site/）从这个文件夹渲染
```

## 发布密钥（谁保管、怎么用、丢了怎么办）

客户端只信任写进程序里的几把**公钥**（`release-keys.txt`），更新清单必须由其中一把的私钥签名。私钥永远不进客户端，也不放在发布更新的服务器上（服务器被攻破不能发出恶意更新）。

| 密钥 | 保管 | 用途 |
|---|---|---|
| **active**（日常签发） | 由 Claude 保管：在开发机 `%USERPROFILE%\.beenet\release\active.key.dpapi`，用 Windows DPAPI 封存（只有这个 Windows 用户、在这台电脑上能解开），文件夹只给该用户访问。签名时在内存里解开，经标准输入交给签名工具，不落盘（`sign-release.ps1`，或 `package.py --sign-vault`）。 | 签每个正式版本的清单 |
| **backup**（备用） | 私钥用一个随机口令加密封存（PBKDF2-SHA256 60 万轮 + AES-256-GCM），封存文件放在开发机和 Mac 的 `~/fabric-build/beenet/release-backup/`；**口令只交给了项目所有者，没有留在任何文件或记忆里**。 | active 丢失或泄露时用 |

- **active 丢了**（开发机坏了）：用 backup 签一个新版本，新版本里写进新的公钥列表，客户端会因为信任 backup 而接受这次更新；之后再生成新的 backup 替换。
- **active 泄露**：同上，用 backup 签一个去掉 active、换上新密钥的版本；在客户端全部升级之前，泄露的 active 仍能签清单，所以要尽快发布，并让服务器上的更新清单只由我们自己的发布流程写入。
- **backup 也泄露**：只有封存文件加口令同时泄露才有风险；这时要靠重新安装新版本客户端（带全新公钥）来更换。
- 之前已经装的 0.1.1、0.1.2 没有写进公钥，**不会自动更新**，需要手动装下一个版本。
- 命令：`release genkey|pubkey|sign|verify|reseal`（见 `release/main.go`）。`release verify -manifest manifest.json -keys release-keys.txt` 用来检查一份清单是不是由受信任的密钥签的。

## 已知的限制

- 显卡占用检测（判断"空闲"看的是 GPU，不看键盘和鼠标）：
  - Windows：GPU 性能计数器按进程读占用，所有品牌的显卡都适用；节点自己的进程（节点代理和它启动的引擎）不计入。已在一台 AMD 8060S 的 Windows 机器上读到真实数值。
  - Linux 的 NVIDIA：`nvidia-smi pmon` 按进程读，同样不计节点自己的进程。
  - Linux 的 AMD、Intel，以及 macOS：只能读整块显卡的占用（内核的 busy 计数、IORegistry 的 Device Utilization %）。节点没在运行时这个数字就是机主的占用，可以用来判断；节点在运行时分不出是谁在用，所以**运行中不会因此停下**。这是这些系统的已知限制。macOS 的键名已在真机上核对。
  - 读不出来的显卡：不会开始共享（页面会说明），选"随时共享"后不看显卡。
- Linux 的 GPU 检测读内核的显示设备列表：只认带渲染节点的 AMD、Intel、NVIDIA 设备，云主机的虚拟显卡（cirrus、virtio 等）和服务器管理芯片（ASPEED）不算；NVIDIA 另用 `nvidia-smi`。
- Linux 上的 Vulkan 引擎要系统里有 Vulkan 加载器（`libvulkan1`）。有桌面的系统一般自带，精简的服务器镜像没有：没装时引擎看不到任何显卡，日志里是 `engine enumerated no accelerator device`，装上（`sudo apt install libvulkan1`）再重启客户端就好。
- 下载源写死在客户端里（llama.cpp 来自 github.com，测速模型和平台分配的模型来自 huggingface.co）。连不上 huggingface.co 的网络（例如国内机房）要先把同一个文件放进数据目录，哈希一致客户端就跳过下载；自动换镜像还没做。
- 页面是浏览器里的网页，没有托盘图标；关掉页面不会停止共享，要在账户页点"关闭客户端"，或再次运行客户端打开页面。
- AMD、Intel 显卡的显存不显示（系统只给出不可靠的数字）；节点自己会测量真正能用的。
- 更新只替换文件，下次启动生效；Windows 程序（安装包、beenet.exe、node-agent.exe）已用北京网梯科技发展有限公司的代码签名证书签名；证书新，SmartScreen 偶尔仍会提示，点“更多信息”再点“仍要运行”。
