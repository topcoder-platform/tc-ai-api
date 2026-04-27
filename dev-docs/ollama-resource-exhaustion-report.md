# Ollama Resource Exhaustion Report

> Date: 2026-04-23
> Scope: TC Ollama on EC2 `g4dn.2xlarge` with NVIDIA Tesla T4
> Evidence: `dev-docs/start-and-run-ollama.log-GPTOSS.txt` and confirmed prior timeout behavior

## Executive Summary

The observed failure was not caused by the model being fundamentally too large for the host. The confirmed trigger was a previous request timeout that left pre-existing memory pressure behind before the next model load attempt. That stale state was then inherited by the following run, causing Ollama to report insufficient available memory and to attempt recovery behavior such as eviction.

After the EC2 instance was restarted, the same model loaded successfully, the Ollama runner started normally, and `/api/chat` requests returned `200` responses. This proves the dominant issue was retained GPU or model state after a timed-out request, not lack of raw host capacity.

## Environment Reality

The instance has about `31 GiB` of system RAM available to Linux, but the relevant constraint for this workload is the Tesla T4 GPU.

- System RAM: about `31 GiB`
- GPU: one Tesla T4
- Usable VRAM reported by Ollama/NVML: about `15.0 GiB`

The `32 GB` expectation applies to host memory, not GPU VRAM. Ollama scheduling decisions for this workload are primarily limited by the T4's VRAM budget.

## What The Logs Prove

### Post-restart successful load

The post-restart log shows:

- `gpu memory ... available="14.1 GiB" free="14.6 GiB"`
- `offloaded 25/25 layers to GPU`
- `model weights device=CUDA0 size="11.8 GiB"`
- `kv cache device=CUDA0 size="858.0 MiB"`
- `compute graph device=CUDA0 size="222.8 MiB"`
- `total memory size="13.9 GiB"`
- `llama runner started in 43.79 seconds`
- successful `/api/chat` responses after load

This means the model fits when the GPU starts from a clean state.

### Earlier failure state

Before restart, Ollama saw only about `5.3 GiB` free VRAM and emitted the eviction message. That earlier state is now explained by the confirmed timed-out request that occurred beforehand.

## Root Cause Assessment

### Primary root cause

The leading diagnosis is incomplete cleanup after a timed-out request. The most likely retained resources are one or more of the following:

- model residency still pinned in VRAM
- KV cache retained after the client stopped waiting
- a long-lived `ollama runner` subprocess
- a stranded CUDA context after abnormal termination

### Why restart fixed it

Restarting the instance cleared the stale state, returned the GPU to near-empty availability, and allowed the same model to load and serve requests. That behavior is consistent with retained runtime state and inconsistent with a permanent sizing failure.

## Secondary Contributing Factors

These factors increase the chance that a timed-out request leaves the host in a bad state:

- large context requests such as `KvSize:32000`
- high batch size such as `BatchSize:512`
- long model residency windows
- insufficient explicit GPU headroom reservation
- large queue depth masking overload

These are not necessarily the original trigger, but they reduce the margin for recovery and make stale memory pressure more likely to break the next request.

## Current Runtime Risk Signals

From the analyzed Ollama configuration in the log:

- `OLLAMA_KEEP_ALIVE=5m0s`
- `OLLAMA_MAX_LOADED_MODELS=0`
- `OLLAMA_NUM_PARALLEL=1`
- `OLLAMA_GPU_OVERHEAD=0`
- `OLLAMA_MAX_QUEUE=512`

The risky defaults for this host are the long keep-alive window, unlimited loaded models, zero explicit GPU overhead, and a very large queue size.

## Recommended Hardening

### Highest-priority controls

Apply these first:

```env
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_KEEP_ALIVE=2m
OLLAMA_NUM_PARALLEL=1
OLLAMA_NUM_CTX=8192
OLLAMA_GPU_OVERHEAD=512
```

Why these settings:

- `OLLAMA_MAX_LOADED_MODELS=1` prevents stale multi-model residency on a T4.
- `OLLAMA_KEEP_ALIVE=2m` shortens the stale-state window after failed or abandoned requests.
- `OLLAMA_NUM_PARALLEL=1` avoids compounding memory pressure on a single T4.
- `OLLAMA_NUM_CTX=8192` prevents runaway KV cache allocation from oversized requests.
- `OLLAMA_GPU_OVERHEAD=512` preserves headroom for transient allocations.

### Optional but useful controls

- reduce `OLLAMA_MAX_QUEUE` to `64` or `128` unless a higher queue is strictly required
- create a custom Modelfile that hard-caps `num_ctx`
- add a warmup request after service restart if cold-start latency matters

## What This Is Not

The current evidence does not prove:

- a deterministic permanent memory leak in all Ollama runs
- a GPU discovery failure in the successful post-restart path
- a host RAM sizing problem as the primary issue for the successful path

There may still be framework-specific or model-specific bugs in the wider ecosystem, but those are not needed to explain this incident.

## Operational Guidance

When a client request times out, do not assume the server-side inference was fully canceled. Treat timeout as a potential stale-resource event until verified otherwise.

The correct post-timeout checks are:

1. inspect loaded models with `ollama ps` or `/api/ps`
2. inspect GPU usage with `nvidia-smi`
3. compare memory against the expected idle baseline
4. if memory remains pinned unexpectedly, unload or restart Ollama before retrying large loads

## Final Conclusion

The incident is best described as timeout-induced resource retention leading to pre-existing memory pressure on the next Ollama load. The restart confirmed that the hardware can support the target model when the GPU is clean. The right response is not just increasing capacity, but hardening post-timeout cleanup and constraining runtime residency on the T4.
