"""Start an eight-worker local fallback demo.

This is useful when the VPN is unavailable. It keeps the same dashboard and
Coordinator APIs, while workers use the deterministic mock backend.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def wait_for_health(base: str, timeout: float = 15.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/healthz", timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("coordinator did not become healthy")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--gpu-count", type=int, default=8)
    args = parser.parse_args()
    if not 1 <= args.gpu_count <= 16:
        raise SystemExit("--gpu-count must be between 1 and 16")

    log_dir = ROOT / "runlogs"
    log_dir.mkdir(exist_ok=True)
    base = f"http://127.0.0.1:{args.port}"
    coordinator_env = os.environ.copy()
    coordinator_env.pop("BABELMESH_MOCK", None)
    coordinator_env["BABELMESH_COORDINATOR_PORT"] = str(args.port)
    coordinator = subprocess.Popen(
        [sys.executable, "-m", "babelmesh_demo"],
        cwd=ROOT,
        env=coordinator_env,
        stdout=(log_dir / "coordinator.out.log").open("a", encoding="utf-8"),
        stderr=(log_dir / "coordinator.err.log").open("a", encoding="utf-8"),
    )
    wait_for_health(base)
    worker_env = coordinator_env | {"BABELMESH_MOCK": "1"}
    for index in range(args.gpu_count):
        subprocess.Popen(
            [
                sys.executable,
                "-m",
                "babelmesh_demo.worker",
                "--coordinator",
                base,
                "--worker-id",
                f"gpu{index}",
                "--gpu-index",
                str(index),
                "--model",
                "Qwen/Qwen2.5-0.5B-Instruct",
            ],
            cwd=ROOT,
            env=worker_env,
            stdout=(log_dir / f"worker{index}.out.log").open("a", encoding="utf-8"),
            stderr=(log_dir / f"worker{index}.err.log").open("a", encoding="utf-8"),
        )
    time.sleep(2)
    print(f"Local demo is running at {base}/ (coordinator pid {coordinator.pid})")
    print(f"Started {args.gpu_count} mock workers; logs are in {log_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
