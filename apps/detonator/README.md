# SupOps detonator — the script sandbox

When the agent proposes a **script** (`run_script`), SupOps detonates it here before it
can run on a real machine: it executes the script in a locked-down, throwaway container
on a network that goes nowhere real, and reports what it tried to do — what it read,
wrote, looked up, and connected to, and whether it touched a planted credential. SupOps
folds that into the risk engine as the raise-only `observed` stage: a script that reads
a credential and dials out is blocked; one that writes a backdoor or wipes logs is
raised; a clean one just fills the "what it would actually do" panel.

This runs **separately from the SupOps server**. It owns the Docker/gVisor socket; the
server, which holds every target credential, never does. Handing the server the Docker
socket would be host-root.

> **Status:** the security-relevant logic (judging a run, assembling the raw outputs,
> the container-hardening args, request validation) lives in `@supops/core`'s `sim/`
> module and in `src/engine.ts`, and is unit-tested there. The actual `docker run`
> path needs Docker (ideally the gVisor `runsc` runtime) and is **not exercised in the
> SupOps dev environment** — build and verify it on a Docker host.

## How it fits together

```
SupOps core  --POST /detonate-->  detonator (owns docker.sock)
  (classify)                         └─ docker run (one throwaway container, locked down)
                                           ├─ --cap-drop ALL, no-new-privileges, read-only, runsc
                                           ├─ network: ONLY the DNS + TCP sinks (internal, no internet)
                                           └─ canary credential files (fake, unique markers)
  core assembles raw outputs  <--{ raw }-- runner collects: docker diff, sink logs, canary opens
  core judges  --> raise-only `observed` risk contributions + the approval panel
```

The runner is **dumb**: it returns the raw outputs under `raw`, and core parses and
judges them (so nothing here is trusted to interpret a payload). On failure it returns
`{ error }`, and core fails closed — no sandbox, no risk reduction.

## Run it (on a Docker host)

1. Build the sandbox image with three fresh canary tokens:
   ```sh
   T1=$(openssl rand -hex 16); T2=$(openssl rand -hex 16); T3=$(openssl rand -hex 16)
   docker build -f Dockerfile.sandbox -t supops-detonate-sandbox \
     --build-arg C1=$T1 --build-arg C2=$T2 --build-arg C3=$T3 .
   ```
2. Set `SUPOPS_CANARY_TOKENS=canary-$T1,canary-$T2,canary-$T3` and the `TCP_SINK_IP` in
   `docker-compose.yml`, then `docker compose up -d`.
3. Point SupOps at it: `SUPOPS_DETONATOR_URL=http://<detonator-host>:7077` (reachable
   only from the SupOps server — keep it off any public address).

Prefer the **gVisor** runtime (`runsc`) for the sandbox; the runner selects it
automatically when `docker info` reports it, else falls back to `runc` with all caps
dropped. gVisor is the stronger isolation boundary and is recommended for untrusted
code.

## Hardening & limits

- One container per script, removed immediately after. `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--read-only` root, a small `noexec` tmpfs,
  pids/memory/cpu limits, a hard `timeout`.
- The sandbox network is `internal` — the only reachable addresses are the sinks, so a
  script cannot actually reach the internet; every lookup and connection attempt is
  logged instead.
- Canaries are **fake** credentials with unique markers. A marker appearing on the wire
  is proof the script exfiltrates; the `LD_PRELOAD` shim (`openlog.c`) also logs canary
  **opens** (best-effort: misses static binaries and raw syscalls).
- **Blind spots** (reported honestly, never assumed safe): the sandbox is a generic
  host, not the target, so paths/services differ; and a sandbox-aware payload can lie
  low — a clean detonation is not proof of safety, which is why the `observed` stage
  only ever *raises* risk.
- The reference sinks key logs by source IP and are single-tenant per IP; for
  concurrent detonations, give each run its own network namespace or run token.
