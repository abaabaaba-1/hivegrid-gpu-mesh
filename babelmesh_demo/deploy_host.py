"""Deploy the BabelMesh control plane and one real worker per GPU.

The base deployment validates CUDA/NVIDIA visibility and reports real GPU
memory. For a model-backed deployment, install the vLLM unit templates from
``babelmesh_demo/deploy`` and point each worker at its local OpenAI-compatible
vLLM endpoint.

Usage:
    python babelmesh_demo/deploy_host.py --host 10.98.10.1 --user ubuntu --gpu-count 8
"""

from __future__ import annotations

import argparse
import getpass
import os
import shlex

import paramiko


FILES = [
    "babelmesh_demo/__init__.py",
    "babelmesh_demo/__main__.py",
    "babelmesh_demo/common.py",
    "babelmesh_demo/coordinator.py",
    "babelmesh_demo/worker.py",
    "babelmesh_demo/demo_client.py",
    "babelmesh_demo/dashboard.html",
    "babelmesh_demo/deploy/babelmesh-coordinator.service",
    "babelmesh_demo/deploy/babelmesh-worker@.service",
    "README-babelmesh-demo.md",
]


def run(client: paramiko.SSHClient, command: str, password: str, timeout: int = 120) -> None:
    print("$", command)
    wrapped = f"sudo -S -p '' -k bash -lc {shlex.quote(command)}"
    stdin, stdout, stderr = client.exec_command(wrapped, timeout=timeout)
    stdin.write(password + "\n")
    stdin.flush()
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")
    if output.strip():
        print(output, end="" if output.endswith("\n") else "\n")
    if error.strip():
        print(error, end="" if error.endswith("\n") else "\n")
    if stdout.channel.recv_exit_status() != 0:
        raise SystemExit(f"remote command failed: {command}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--user", default="ubuntu")
    parser.add_argument("--gpu-count", type=int, default=8)
    parser.add_argument("--skip-cuda-runtime", action="store_true")
    args = parser.parse_args()
    if args.gpu_count < 1 or args.gpu_count > 16:
        raise SystemExit("--gpu-count must be between 1 and 16")

    password = getpass.getpass("SSH password: ")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(args.host, port=args.port, username=args.user, password=password, timeout=30, banner_timeout=30, auth_timeout=30)
    sftp = client.open_sftp()
    for directory in ["/opt/babelmesh-demo", "/opt/babelmesh-demo/babelmesh_demo", "/opt/babelmesh-demo/babelmesh_demo/deploy"]:
        run(client, f"mkdir -p {directory}", password)
    for rel in FILES:
        remote = "/opt/babelmesh-demo/" + rel.replace("\\", "/")
        sftp.put(os.path.join(root, rel), "/tmp/babelmesh-upload")
        run(client, f"install -m 0644 /tmp/babelmesh-upload {remote}", password)
    sftp.close()

    run(client, "python3 -m py_compile /opt/babelmesh-demo/babelmesh_demo/*.py", password)
    if not args.skip_cuda_runtime:
        run(client, "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libcudart12", password, timeout=900)
    run(client, "install -m 0644 /opt/babelmesh-demo/babelmesh_demo/deploy/babelmesh-coordinator.service /etc/systemd/system/babelmesh-coordinator.service", password)
    run(client, "install -m 0644 /opt/babelmesh-demo/babelmesh_demo/deploy/babelmesh-worker@.service /etc/systemd/system/babelmesh-worker@.service", password)
    run(client, "systemctl daemon-reload", password)
    run(client, "systemctl enable --now babelmesh-coordinator.service", password)
    for index in range(args.gpu_count):
        run(client, f"systemctl enable --now babelmesh-worker@{index}.service", password)
    units = " ".join(f"babelmesh-worker@{index}.service" for index in range(args.gpu_count))
    run(client, f"systemctl restart {units}", password)
    run(client, "curl --fail --silent http://127.0.0.1:8000/healthz && echo", password)
    run(client, "curl --fail --silent http://127.0.0.1:8000/v1/nodes", password)
    client.close()
    print("deployment complete")


if __name__ == "__main__":
    main()
