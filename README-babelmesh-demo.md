# BabelMesh 多 GPU Worker 与 Coordinator 演示节点

这是需求文档 V0.1 的单机多 GPU 控制面原型：Coordinator 管理节点注册、能力目录、任务队列、路由、幂等、超时、重试、故障摘除和指标；每个 Worker 绑定一张 GPU 并执行模型推理。

## 标准接口

Coordinator 默认监听 `0.0.0.0:8000`，提供：

```text
GET  /healthz
GET  /v1/nodes
POST /v1/nodes/register
POST /v1/nodes/{id}/heartbeat
POST /v1/tasks
GET  /v1/tasks/{id}
POST /v1/tasks/{id}/cancel
GET  /metrics
GET  /v1/tasks?limit=50&status=succeeded
```

根路径 `/`（或 `/dashboard.html`）提供 BeeNet 风格的演示控制台：浅色蜂网视觉、GPU 节点状态、实时任务流、调度吞吐、成功率/P95 延迟和任务提交表单。控制台直接读取 Coordinator 的真实状态，不依赖额外前端构建工具。

Worker 使用的内部控制接口是 `/v1/tasks/claim` 和 `/v1/tasks/{id}/result`。旧的 `/health`、`/workers`、`/register`、`/heartbeat`、`/submit`、`/claim`、`/result`、`/tasks/{id}` 路径仍保留为演示兼容别名。

提交示例：

```json
{
  "idempotency_key": "demo-001",
  "model": "demo",
  "input": {"prompt": "Explain distributed inference"},
  "deadline_ms": 120000,
  "max_retries": 1
}
```

相同幂等键和相同请求会返回原任务；相同幂等键但请求内容不同会返回 409。任务状态为 `queued`、`running`、`succeeded`、`failed`、`timeout` 或 `cancelled`。Worker 心跳超时会标记为 `offline`，运行中的任务会最多按 `max_retries` 重新排队。

## 本地运行

```powershell
python -m babelmesh_demo
python -m babelmesh_demo.worker --worker-id gpu0 --gpu-index 0 --model demo
python -m babelmesh_demo.worker --worker-id gpu1 --gpu-index 1 --model demo
python -m babelmesh_demo.demo_client "hello from BabelMesh" --idempotency-key demo-001
```

没有 CUDA 时，可使用 `BABELMESH_MOCK=1` 启动演示 worker。项目自带 `scripts/demo.py`，会自动启动 Coordinator 和两个 mock worker，提交任务、停止一个 worker、展示重试和指标，然后清理进程：

```powershell
python scripts/demo.py
```

明天现场演示建议直接使用：

```powershell
# 终端 1：启动控制面（页面地址为 http://127.0.0.1:8000/）
python -m babelmesh_demo

# 终端 2/3：没有 CUDA 时启动两个可重复的 mock worker
$env:BABELMESH_MOCK=1; python -m babelmesh_demo.worker --coordinator http://127.0.0.1:8000 --worker-id gpu0 --gpu-index 0 --model demo
$env:BABELMESH_MOCK=1; python -m babelmesh_demo.worker --coordinator http://127.0.0.1:8000 --worker-id gpu1 --gpu-index 1 --model demo
```

打开页面后点击“开始演示”，提交一个问题即可看到路由、执行、结果回写和指标变化。需要展示容错时，可以运行 `python scripts/demo.py`，脚本会自动注入 GPU0 故障并展示 GPU1 重试。

项目同时包含 BeeNet Windows 客户端：`client-0.3.2/beenet.exe`，默认提供本机
`http://127.0.0.1:18650/` 页面；`client-0.3.2/node-agent.exe` 是节点代理。客户端
负责蜂网账户、聊天和共享 GPU，BabelMesh 页面负责本次八卡集群调度演示。

## 测试

```powershell
python -m unittest discover -s tests -v
```

测试覆盖标准接口、模型/显存路由、幂等、取消、超时、worker 离线重试和指标。

## vLLM 后端

部署文件支持每张 GPU 一个单卡 vLLM 服务。Worker 领取任务后调用对应端口的
`/v1/chat/completions`；服务使用 `VLLM_USE_FLASHINFER_SAMPLER=0` 和
`--enforce-eager`，不依赖远端 CUDA toolkit 编译采样内核。默认模型是
`Qwen/Qwen2.5-0.5B-Instruct`。

`deploy_vllm.py` 是早期双卡测试脚本；八卡主机使用下面的 systemd 模板和环境文件，
避免把公网入口误当成 6000D 的 Ubuntu 地址。

## 6000D 八卡主机接入

如果先做真实 GPU 控制面演示，使用 `deploy_host.py`。它把每张物理 GPU 注册成一个
Worker，读取真实的 NVIDIA 显存和 CUDA 状态，并由 Coordinator 统一路由任务：

```powershell
python babelmesh_demo/deploy_host.py --host 10.98.10.1 --user ubuntu --gpu-count 8
```

接入后在 VPN 内打开 `http://10.98.10.1:8000/`。

### 八卡真实模型演示

真实模型部署使用 ModelScope 下载到本机的模型快照，在每张 GPU 上启动一个 vLLM 实例，
端口从 `18100` 到 `18107`。当前八卡主机已配置为 `Qwen/Qwen2.5-0.5B-Instruct`，
并以 systemd 开机自启：

```text
/etc/babelmesh/vllm-0.env
/etc/babelmesh/worker-vllm-0.env
```

打开页面后选择 `Qwen2.5 · vLLM`，提交问题即可看到真实回答；节点卡片仍显示 8 张
RTX 6000D 在线状态和对应任务路由。首次请求可能触发模型 warm-up，部署脚本已对八个
端口预热过一次。
