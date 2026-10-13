import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time
import urllib.request

here = Path(__file__).resolve().parent
wrangler, output = sys.argv[1:]
modes = json.loads((here / "floor-modes.json").read_text())
reference = json.loads((here / ".generated/reference.json").read_text()).encode()
output = Path(output).resolve()


class Shape(HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.rows = self.links = self.svgs = 0
        self.feed(body.decode())

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        self.rows += "data-id" in attrs
        self.links += tag == "a" and "href" in attrs
        self.svgs += tag == "svg"


def cpu_seconds(pid):
    value = subprocess.check_output(["ps", "-p", pid, "-o", "time="], text=True).strip()
    seconds = 0
    for part in value.split(":"):
        seconds = seconds * 60 + float(part)
    return seconds


def render_pid(parent):
    lines = [line.split() for line in subprocess.check_output(["ps", "-axo", "pid,ppid,command"], text=True).splitlines()]
    descendants = {str(parent)}
    for _ in range(5):
        descendants.update(parts[0] for parts in lines if len(parts) > 2 and parts[1] in descendants)
    found = [parts[0] for parts in lines if parts[0] in descendants and "workerd serve" in " ".join(parts) and "--inspector-addr=" in " ".join(parts)]
    assert len(found) == 1, found
    return found[0]


def measure(mode, round_number):
    log_path = output.with_name(f"floor-{round_number}-{mode}.log")
    with log_path.open("w") as log:
        process = subprocess.Popen([wrangler, "dev", "--config", ".generated/floor-wrangler.json", "--port", "20218", "--inspector-port", "20219", "--local"], cwd=here, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(150):
                assert process.poll() is None, log_path.read_text()
                if "Ready on" in log_path.read_text():
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError(f"server did not start: {log_path}")
            pid = render_pid(process.pid)

            def request():
                started = time.perf_counter()
                with urllib.request.urlopen(f"http://127.0.0.1:20218/?mode={mode}", timeout=15) as response:
                    body = response.read()
                    assert response.status == 200 and response.headers["x-spike-floor-mode"] == mode
                return (time.perf_counter() - started) * 1000, body

            for _ in range(10):
                _, body = request()
            expected = body
            if mode == "full":
                assert expected == reference
            count = 300 if mode in ("static", "serialize-only") else 30
            before = cpu_seconds(pid)
            samples = []
            for _ in range(count):
                elapsed, body = request()
                assert body == expected, f"unstable output: {mode}"
                samples.append(elapsed)
            cpu = (cpu_seconds(pid) - before) * 1000 / count
            shape = Shape(expected)
            return {"round": round_number, "mode": mode, "requests": count, "warmupRequests": 10,
                    "processCpuMsPerRender": cpu, "medianWallMs": statistics.median(samples),
                    "p95WallMs": sorted(samples)[int(count * 0.95) - 1],
                    "bytes": len(expected), "byteIdentical": expected == reference,
                    "sha256": hashlib.sha256(expected).hexdigest(),
                    "rowNodes": shape.rows, "links": shape.links, "svgs": shape.svgs}
        finally:
            process.terminate()
            process.wait(timeout=10)


report = {"note": "Local workerd, captured queries, no profiler. Two rounds in opposite order; each mode starts a fresh process. CPU is process CPU, not Cloudflare billed CPU. HTML equality covers one snapshot only. Static controls are not dynamic-render lower bounds.", "modes": modes, "runs": []}
for round_number, order in enumerate([list(modes), list(reversed(modes))], 1):
    for mode in order:
        result = measure(mode, round_number)
        report["runs"].append(result)
        output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(result), flush=True)
