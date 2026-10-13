import json
import statistics
import subprocess
import sys
import time
import urllib.request

# Whole-process CPU provides a second local estimate independent of CDP's
# sampler. Run only against the spike's idle workerd process, without profiling.
pid, endpoint, output = sys.argv[1:]


def cpu_seconds():
    value = subprocess.check_output(["ps", "-p", pid, "-o", "time="], text=True).strip()
    seconds = 0
    for part in value.split(":"):
        seconds = seconds * 60 + float(part)
    return seconds


def request():
    start = time.perf_counter()
    with urllib.request.urlopen(endpoint) as response:
        html = response.read()
        assert response.status == 200 and b"Flamengo" in html and b"data-served" in html
    return (time.perf_counter() - start) * 1000


# Compare fresh processes with the same warmup; JIT and startup CPU otherwise
# swamp the difference between rendering changes.
for _ in range(10):
    request()
before = cpu_seconds()
samples = [request() for _ in range(30)]
after = cpu_seconds()
result = {
    "warmupRequests": 10,
    "requests": len(samples),
    "medianWallMs": statistics.median(samples),
    "p95WallMs": sorted(samples)[28],
    "processCpuMsPerRender": (after - before) * 1000 / len(samples),
    "samplesMs": samples,
    "note": "Local workerd with captured public data, profiler disconnected. Process CPU includes runtime overhead; not Cloudflare billed CPU."
}
with open(output, "w") as handle:
    json.dump(result, handle, indent=2)
print(json.dumps(result))
