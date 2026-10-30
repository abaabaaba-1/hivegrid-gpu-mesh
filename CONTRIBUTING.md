# Contributing

HiveGrid is currently a demo-ready control plane. Changes should keep the local
demo usable without NVIDIA hardware and should preserve the HTTP API documented
in `beenet-api-contract.md`.

Before opening a pull request, run:

```powershell
python -m compileall -q babelmesh_demo beenet_compat scripts tests
python -m unittest discover -s tests -v
```

Pull requests are checked by GitHub Actions on Python 3.11, 3.12, and 3.13.
Do not commit credentials, VPN exports, private keys, model weights, runtime
logs, or downloaded toolchains. Put deployment-only values in environment files
on the target host or in a secret manager.
