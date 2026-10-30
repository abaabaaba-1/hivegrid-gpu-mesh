"""Deploy the demo package and vLLM systemd units to the target VM.

Usage (from the repository root):
    python babelmesh_demo/deploy_vllm.py --host 61.49.59.158 --port 10022 --user root

The password is requested interactively so it is not stored in this repository.
"""

from __future__ import annotations

import argparse
import getpass
import os
import posixpath
import subprocess

import paramiko


FILES = [
    "babelmesh_demo/__init__.py",
    "babelmesh_demo/__main__.py",
    "babelmesh_demo/common.py",
    "babelmesh_demo/coordinator.py",
    "babelmesh_demo/worker.py",
    "babelmesh_demo/demo_client.py",
    "babelmesh_demo/dashboard.html",
    "README-babelmesh-demo.md",
]
UNITS = [
    "babelmesh-coordinator.service",
    "babelmesh-worker-gpu0.service",
    "babelmesh-worker-gpu1.service",
    "babelmesh-vllm-gpu0.service",
    "babelmesh-vllm-gpu1.service",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--user", default="root")
    parser.add_argument("--skip-install", action="store_true")
    args = parser.parse_args()
    password = getpass.getpass("SSH password: ")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(args.host, port=args.port, username=args.user, password=password, timeout=30, banner_timeout=30, auth_timeout=30)
    sftp = client.open_sftp()
    for directory in ["/opt/babelmesh-demo", "/opt/babelmesh-demo/babelmesh_demo", "/opt/babelmesh-demo/deploy", "/opt/babelmesh-models/hf"]:
        client.exec_command(f"mkdir -p {directory}")
    for rel in FILES:
        sftp.put(os.path.join(root, rel), "/opt/babelmesh-demo/" + rel.replace("\\", "/"))
    for unit in UNITS:
        sftp.put(os.path.join(root, "babelmesh_demo", "deploy", unit), "/etc/systemd/system/" + unit)
    sftp.close()
    commands = [
        "cd /opt/babelmesh-demo && /usr/bin/python3 -m py_compile babelmesh_demo/*.py",
    ]
    if not args.skip_install:
        commands += [
            "test -x /opt/babelmesh-demo/.venv/bin/python || /usr/bin/python3 -m venv /opt/babelmesh-demo/.venv",
            "/opt/babelmesh-demo/.venv/bin/python -m pip install -U pip uv",
            "/opt/babelmesh-demo/.venv/bin/uv pip install vllm --torch-backend=auto",
        ]
    commands += [
        "systemctl daemon-reload",
        "systemctl enable --now babelmesh-coordinator.service babelmesh-vllm-gpu0.service babelmesh-vllm-gpu1.service",
        "systemctl restart babelmesh-worker-gpu0.service babelmesh-worker-gpu1.service",
    ]
    for command in commands:
        print("$", command)
        _, stdout, stderr = client.exec_command(command, timeout=1800)
        output = stdout.read().decode(errors="replace")
        error = stderr.read().decode(errors="replace")
        if output.strip():
            print(output)
        if error.strip():
            print(error)
        if stdout.channel.recv_exit_status() != 0:
            raise SystemExit(f"remote command failed: {command}")
    client.close()
    print("deployment complete")


if __name__ == "__main__":
    main()
