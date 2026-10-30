"""Small command-line client for the standard coordinator API."""

from __future__ import annotations

import argparse
import json
import time

from .common import request_json


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt")
    parser.add_argument("--coordinator", default="http://127.0.0.1:8000")
    parser.add_argument("--model", default="demo")
    parser.add_argument("--gpu")
    parser.add_argument("--idempotency-key")
    parser.add_argument("--deadline-ms", type=int, default=120000)
    parser.add_argument("--max-retries", type=int, default=1)
    args = parser.parse_args()
    base = args.coordinator.rstrip("/")
    body = {"model": args.model, "input": {"prompt": args.prompt}, "deadline_ms": args.deadline_ms, "max_retries": args.max_retries}
    if args.gpu is not None:
        body["preferred_gpu"] = args.gpu
    if args.idempotency_key:
        body["idempotency_key"] = args.idempotency_key
    task = request_json(base + "/v1/tasks", "POST", body)
    print(json.dumps(task, ensure_ascii=False, indent=2))
    task_id = task["task_id"]
    for _ in range(max(1, int(args.deadline_ms / 1000) + 5)):
        status = request_json(base + "/v1/tasks/" + task_id)
        if status.get("status") in {"succeeded", "failed", "timeout", "cancelled"}:
            print(json.dumps(status, ensure_ascii=False, indent=2))
            return
        time.sleep(1)
    raise SystemExit("timeout waiting for task")


if __name__ == "__main__":
    main()
