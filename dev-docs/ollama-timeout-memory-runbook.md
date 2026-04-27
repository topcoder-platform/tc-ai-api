# Ollama Timeout Memory Runbook

> Purpose: Recover and stabilize a T4-backed Ollama host after a timed-out request leaves stale memory pressure behind.
> Environment: EC2 `g4dn.2xlarge`, Ollama, NVIDIA Tesla T4

## When To Use This Runbook

Use this runbook when one or more of the following is true:

- a prior Ollama request timed out
- the next model load fails with insufficient memory
- `ollama ps` does not explain current GPU usage
- `nvidia-smi` shows unexpectedly high VRAM usage after request completion
- Ollama starts evicting models to make space on a host that usually handles the model

## Expected Baseline

On a healthy idle host after startup, the Tesla T4 should show most VRAM free. In the observed healthy run, Ollama saw about `14.6 GiB` free and about `14.1 GiB` safely available.

## Triage Checklist

### 1. Confirm the incident pattern

Ask:

- did a request time out before the current failure?
- did the next request fail without a host restart?
- is the failure resolved by restart?

If yes, treat this as likely stale runtime state.

### 2. Check Ollama's view of loaded models

```bash
ollama ps
```

Or:

```bash
curl -s http://127.0.0.1:11434/api/ps
```

### 3. Check actual GPU memory

```bash
nvidia-smi
```

If `ollama ps` looks empty or inconsistent but VRAM remains high, suspect stale runner or stranded CUDA context.

### 4. Check for lingering runner processes

```bash
ps -ef | grep "ollama runner" | grep -v grep
```

If runner processes remain after the workload should be gone, treat them as stale until proven otherwise.

## Recovery Procedure

### Safe recovery

1. stop new traffic to Ollama
2. inspect `ollama ps`
3. inspect `nvidia-smi`
4. wait briefly for the keep-alive window if the request just ended

If memory remains pinned unexpectedly, continue.

### Forced recovery

If Ollama is managed by systemd:

```bash
sudo systemctl stop ollama
pkill -f "ollama runner"
sudo systemctl start ollama
```

If Ollama runs in Docker:

```bash
docker stop ollama
pkill -f "ollama runner"
docker start ollama
```

### Only if host RAM accounting is also abnormal

Use this only when Linux page cache or host-memory accounting is part of the issue, not as the default first response to pure VRAM retention:

```bash
sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
```

## Post-Recovery Validation

After restart or forced cleanup:

1. run `nvidia-smi`
2. confirm VRAM returned close to idle baseline
3. load the model again
4. confirm Ollama no longer emits eviction messages
5. send one warmup request
6. verify the first successful request after recovery

## Preventive Configuration

Apply these settings to reduce recurrence on a Tesla T4:

```env
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_KEEP_ALIVE=2m
OLLAMA_NUM_PARALLEL=1
OLLAMA_NUM_CTX=8192
OLLAMA_GPU_OVERHEAD=512
```

Consider also:

```env
OLLAMA_MAX_QUEUE=128
```

## Timeout-Aware Application Behavior

Client timeout does not guarantee server-side cancellation. The application or workflow invoking Ollama should do the following after timeout:

1. log the timeout with model name and context size
2. check whether the model remains loaded
3. compare current VRAM to expected idle state
4. trigger unload or restart if memory remains pinned beyond the keep-alive window
5. avoid immediately retrying another large request on the same dirty host

## Suggested Watchdog Rules

Use watchdog automation when any of the following conditions persist:

- no expected active workload, but VRAM remains high
- repeated timeout followed by failed next load
- `ollama ps` is inconsistent with `nvidia-smi`
- runner processes remain alive after the keep-alive window

## Example Operational Commands

### Inspect current Ollama state

```bash
ollama ps
curl -s http://127.0.0.1:11434/api/ps
nvidia-smi
ps -ef | grep "ollama runner" | grep -v grep
```

### Quick service recovery

```bash
sudo systemctl restart ollama
```

### Stronger cleanup when restart alone is insufficient

```bash
sudo systemctl stop ollama
pkill -f "ollama runner"
sudo systemctl start ollama
```

## Escalation Guidance

Escalate beyond runtime tuning when any of the following is true:

- the workload requires very large contexts beyond the T4 safety margin
- multiple models must remain hot concurrently
- true memory drift persists even with short keep-alive and explicit cleanup
- repeated timeouts continue under normal expected request size

In those cases, investigate the calling framework, request sizing, and whether a larger-VRAM GPU is required.

## Incident Summary Template

Use this format for future incidents:

```text
Timestamp:
Model:
Request type:
Did client timeout occur:
VRAM before timeout:
VRAM after timeout:
ollama ps output:
nvidia-smi summary:
Were runner processes present:
Recovery action taken:
Did model load succeed after recovery:
```
