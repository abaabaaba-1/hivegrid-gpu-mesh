# 6000D 八卡机连接记录

本文记录 BeeNet 项目连接 6000D 八卡机的方式。目标设备是 BMC 地址为 `10.98.10.101`、操作系统地址为 `10.98.10.1` 的机器；不要把这里的地址与之前的 A100 实例混用。

## 设备确认

- BMC 型号：`EG8621A4-S`（Enginetech）
- BMC 地址：`10.98.10.101`
- 操作系统地址：`10.98.10.1`
- 硬件清单：8 × `NVIDIA GeForce RTX 6000D`
- 操作系统：Ubuntu
- BMC 状态：已验证为开机

## 连接顺序

### 1. 先接入 VPN

当前使用 iNode/SSL VPN。浏览器入口有以下两个地址，实际以能显示“已连接/主页”的入口为准：

```text
https://124.251.110.124:4430/login/login.html
https://61.49.59.158:60443/
```

VPN 登录用户名从密码管理器读取。密码不写入项目文档，使用密码管理器或用户提供的凭据输入。

VPN 连通后，Windows 应出现到 `10.98.10.0/24` 的路由。PowerShell 检查：

```powershell
Get-NetRoute -DestinationPrefix '10.98.10.0/24'
Test-NetConnection 10.98.10.101 -Port 80
Test-NetConnection 10.98.10.1 -Port 22
```

正常时，路由应走 iNode VPN 网卡（本次验证的接口索引为 `46`，网关为 `10.98.255.1`）。如果路由走 Clash/TUN 或其他代理，先关闭该冲突路由，再重新连接 VPN。

### 2. 通过 BMC 网页确认机器和启动 KVM

在 VPN 连接保持期间打开：

```text
http://10.98.10.101/
```

登录 BMC 后进入“远程控制”，点击“启动 KVM”。KVM 地址通常为：

```text
http://10.98.10.101/viewer.html
```

BMC 账号为 `admin`。密码不保存到仓库。KVM 只用于查看/操作这台 6000D 的本地显示器和终端；不要在此页面对电源执行重启、关机或固件操作，除非另有明确安排。

### 3. 优先使用 Ubuntu SSH

操作系统账号为 `ubuntu`，目标地址是 `10.98.10.1`：

```bash
ssh ubuntu@10.98.10.1
```

首次连接时核对主机指纹。密码不写入命令行、脚本或项目文件。

如果 SSH 不通，先在 VPN 本机执行：

```powershell
Test-NetConnection 10.98.10.1 -Port 22 -InformationLevel Detailed
```

再通过 BMC KVM 在 Ubuntu 本地终端检查：

```bash
ip -br addr
ip route
sudo systemctl status ssh --no-pager
sudo ss -lntp | grep ':22'
```

本次记录时 BMC 可访问，但 `10.98.10.1:22` 尚未确认可用；因此 SSH 失败时应回到 KVM 检查系统网络和 `sshd`，不要把 BMC 地址当成操作系统地址。

## 连接成功后的 BeeNet 操作入口

进入 Ubuntu 后，先确认机器确实是 6000D，再进行 BeeNet 安装或节点注册：

```bash
hostname
cat /etc/os-release
nvidia-smi
ip -br addr
```

确认 `nvidia-smi` 显示 8 张 RTX 6000D 后，再按项目部署文档启动 worker。部署前记录现有 NVIDIA 驱动、CUDA、Docker 和 Python 版本，避免覆盖已有环境。

## 排障要点

1. `10.98.10.101:80` 通而 `10.98.10.1:22` 不通：VPN 到 BMC 正常，问题在 Ubuntu 网络、SSH 服务或防火墙，应使用 KVM 检查。
2. 两个地址都不通：检查 VPN 是否仍在线，以及 `10.98.10.0/24` 是否仍经 iNode 路由。
3. 浏览器显示超时但 PowerShell 可通：检查浏览器代理/Clash 是否拦截私网地址，确保 `10.98.10.0/24` 直连 VPN。
4. 看到 A100、火山引擎或其他公网实例信息时停止操作，重新核对目标必须是 `10.98.10.1` / `10.98.10.101`。

## 凭据安全

密码、VPN 会话、SSH 私钥和 BMC 会话信息不得提交到 Git。若此文档需要共享给其他人，应先移除用户名或改成“从密码管理器读取”，并在凭据曾暴露到聊天或日志后安排轮换。

## 本次验证记录（2026-10-30）

- 已通过 SSH 登录到 `ubuntu@10.98.10.1`，系统为 Ubuntu 24.04.5 LTS，内核固定为 `6.8.0-147-generic`。
- 已安装 NVIDIA `595.99.02` 驱动和 `libcudart12`；8 张 RTX 6000D 均由 `nvidia` 接管，`nvidia-smi` 显示每张约 85.6 GiB 显存。
- 3 张卡原先处于 Confidential Compute 模式，已用 NVIDIA GPU Admin Tools 关闭并复位；其余 5 张卡保持正常模式。
- `ubuntu-vm`、`ubuntu-vm2`、`ubuntu-vm3`、`ubuntu-vm4` 均保留但已关机，且没有虚拟机开机自启，避免再次抢占 GPU 的 `vfio-pci` 绑定。
- BabelMesh 控制面已部署到 `/opt/babelmesh-demo`：`babelmesh-coordinator.service` 和 `babelmesh-worker@0..7.service` 已启用，8 个 Worker 全部在线。
- VPN 内的演示入口为 `http://10.98.10.1:8000/`；已完成真实任务路由验证，任务成功运行在 `gpu7`。
- 真实模型链路已切换为 vLLM：`babelmesh-vllm@0..7.service` 和 `babelmesh-worker-vllm@0..7.service` 均已启用，端口为 `18100..18107`，模型为 `Qwen/Qwen2.5-0.5B-Instruct`。
- 八个 vLLM 实例均已通过 `/v1/models` 健康检查，BabelMesh `/v1/nodes` 返回 8 个 `backend=vllm`、`status=ready` 的 RTX 6000D 节点；控制台已完成真实回答验证。

## BeeNet 接入验证（2026-10-30）

远端用户目录下的 BeeNet 0.3.2 客户端路径为 `~/.local/bin/beenet`，节点代理为 `~/.local/bin/node-agent`。首次接入可按以下顺序执行：

```bash
# 确认驱动已加载；如果 nvidia-smi 报无法通信，先加载已安装的模块
printf '%s\n' '<Ubuntu 密码>' | sudo -S modprobe nvidia
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader

# 启动客户端并完成登录后，开启“空闲时共享”
beenet share on --yes
beenet service install
printf '%s\n' '<Ubuntu 密码>' | sudo -S loginctl enable-linger ubuntu
```

客户端的测速模型放在数据目录的 `ref/` 子目录，而不是 `downloads/`：

```text
~/.config/BeeNet/ref/qwen2.5-1.5b-instruct-q4_k_m.gguf
```

如果远端访问 Hugging Face 超时，可从可访问的镜像下载该文件后放入上述路径，并核对 SHA-256：

```text
6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e
```

本次最终验证结果：8 张 RTX 6000D 均被 `nvidia-smi` 和 BeeNet 识别；BeeNet 账户信息不写入项目文档，共享策略为显卡空闲 5 分钟后共享，状态为 `waiting`；`beenet.service` 为 `enabled` 且 `active`。GPU0 当时仍有 `VLLM::EngineCore` 占用约 2.5 GiB，因此空闲策略不会立即借出该卡。


