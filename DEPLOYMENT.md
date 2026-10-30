# Deployment guide

This document covers the two supported paths:

1. a local, GPU-free demo for review and presentations;
2. a production-style single-host deployment with one Coordinator, one vLLM
   process per GPU, and one Worker per GPU.

The GitHub Actions workflow validates source code and tests. Production rollout
is intentionally explicit: run it from an operator workstation after reviewing
the target host, model path, and service configuration.

## 1. Local demo

Requirements: Python 3.11 or newer. No CUDA, model download, or third-party
Python package is needed.

```powershell
python scripts/start_local_demo.py
```

Open `http://127.0.0.1:8000/`. The script starts one Coordinator and eight
mock Workers. Logs are written to `runlogs/`, which is ignored by Git. Stop the
processes from Task Manager or restart the shell before starting another demo on
port 8000.

For a short automated demonstration that cleans up its own processes:

```powershell
python scripts/demo.py
```

## 2. Production host prerequisites

The examples assume an Ubuntu host with:

- Python 3.11 or newer;
- a working NVIDIA driver and `nvidia-smi` for every GPU;
- one vLLM virtual environment at `/opt/babelmesh-vllm/.venv`;
- a model already downloaded to a host path readable by that environment;
- a private network path from the browser to Coordinator port 8000.

Create the optional deployment-helper environment on the operator workstation:

```powershell
python -m venv .venv-deploy
.\.venv-deploy\Scripts\python -m pip install -r requirements-deploy.txt
```

The deployment helpers ask for the SSH password interactively. They do not read
credentials from this repository.

## 3. Install the control plane

Copy the tracked runtime files to `/opt/babelmesh-demo` (or use your normal artifact
transfer process), then install the Coordinator unit:

```bash
sudo mkdir -p /opt/babelmesh-demo
sudo cp -a babelmesh_demo /opt/babelmesh-demo/
sudo install -m 0644 babelmesh_demo/deploy/babelmesh-coordinator.service \
  /etc/systemd/system/babelmesh-coordinator.service
sudo systemctl daemon-reload
sudo systemctl enable --now babelmesh-coordinator.service
curl --fail http://127.0.0.1:8000/healthz
```

The service file uses `/opt/babelmesh-demo` as its working directory. If the
installation directory differs, update `WorkingDirectory` and `ExecStart`
before enabling the unit.

For the existing helper, the base GPU deployment is:

```powershell
python babelmesh_demo/deploy_host.py --host <private-host> --user <ssh-user> --gpu-count 8
```

Use `--skip-cuda-runtime` when the host image already provides the CUDA runtime.
The helper validates Python syntax, installs the Coordinator and generic Worker
units, enables one Worker per GPU, and checks `/healthz` and `/v1/nodes`.

## 4. Configure vLLM workers

The repository includes templates in `babelmesh_demo/deploy/`. Create one vLLM
environment file and one Worker environment file per GPU. Example for GPU 0:

`/etc/babelmesh/vllm-0.env`

```bash
BABELMESH_MODEL_PATH=/opt/babelmesh-models/hf/Qwen2.5-0.5B-Instruct
BABELMESH_VLLM_PORT=18100
BABELMESH_SERVED_MODEL=Qwen/Qwen2.5-0.5B-Instruct
```

`/etc/babelmesh/worker-vllm-0.env`

```bash
BABELMESH_MODEL=Qwen/Qwen2.5-0.5B-Instruct
BABELMESH_VLLM_URL=http://127.0.0.1:18100/v1
BABELMESH_VLLM_TIMEOUT=120
```

For GPU `N`, use port `18100 + N` and substitute `N` in both filenames. Keep
these files mode `0600` if a private model token is added. Never commit them.

Install and start all eight instances:

```bash
sudo install -d -m 0755 /etc/babelmesh
sudo install -m 0644 babelmesh_demo/deploy/babelmesh-vllm@.service /etc/systemd/system/
sudo install -m 0644 babelmesh_demo/deploy/babelmesh-worker-vllm@.service /etc/systemd/system/
sudo systemctl daemon-reload
for gpu in $(seq 0 7); do
  sudo systemctl enable --now babelmesh-vllm@${gpu}.service
  sudo systemctl enable --now babelmesh-worker-vllm@${gpu}.service
done
```

Validate the model endpoints and registration:

```bash
curl --fail http://127.0.0.1:18100/v1/models
curl --fail http://127.0.0.1:8000/healthz
curl --fail http://127.0.0.1:8000/v1/nodes
```

## 5. Upgrade and rollback

Deploy into a new versioned directory, compile before switching the service,
then restart one unit group at a time. Keep the previous directory until the
health checks and a real inference request succeed.

```bash
python3 -m compileall -q /opt/babelmesh-demo/babelmesh_demo
sudo systemctl restart babelmesh-coordinator.service
sudo systemctl restart babelmesh-worker-vllm@0.service
curl --fail http://127.0.0.1:8000/healthz
```

To roll back, point the unit back to the previous directory and restart the
Coordinator and Worker units. Inspect failures with:

```bash
sudo systemctl --failed
sudo journalctl -u babelmesh-coordinator.service -n 100 --no-pager
sudo journalctl -u 'babelmesh-worker-vllm@*.service' -n 100 --no-pager
```

## 6. Network exposure

Expose the dashboard through an internal reverse proxy or VPN. Keep Coordinator
port 8000 off the public Internet unless authentication and an allowlist are
added. The dashboard is a presentation surface; `/v1/nodes/register`, task
control endpoints, and metrics should be restricted to the control-plane
network.
