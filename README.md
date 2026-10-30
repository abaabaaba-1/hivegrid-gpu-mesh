# HiveGrid GPU Mesh

HiveGrid is a multi-GPU inference control plane for registering GPU workers,
routing model tasks, tracking execution, and recovering from worker failures.
It includes a lightweight visual dashboard, a coordinator API, vLLM-backed
workers, and a local mock mode for demos without a GPU.

## Quick start

```powershell
python scripts/start_local_demo.py
```

Open `http://127.0.0.1:8000/` to view the dashboard. The local fallback starts
eight mock workers so the node map, task flow, metrics, and retry behavior can
be demonstrated without the production GPU host.

## Production layout

The same coordinator API runs on an NVIDIA host with one vLLM instance and one
worker per GPU. The deployment notes cover the RTX 6000D host, systemd units,
model configuration, and the presentation flow:

- [README-babelmesh-demo.md](README-babelmesh-demo.md)
- [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md)
- [6000D_CONNECTION.md](6000D_CONNECTION.md)

## Validation

```powershell
python -m unittest discover -s tests -v
```
