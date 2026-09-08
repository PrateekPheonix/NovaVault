#!/usr/bin/env python3
"""
Phase 0 spike: is local whisper.cpp fast enough for the PRD's 1-3s budget (§30)?

The metric that matters is inference time with the model already resident - a real app
loads once at startup. whisper-cli reloads per invocation, so we subtract its reported
load time rather than trusting wall clock.
"""
import re, subprocess, statistics, json, sys, pathlib

MODELS = ["tiny.en", "base.en", "small.en"]
CLIPS  = [("speech-3s.wav", 3.0), ("speech-5s.wav", 5.0),
          ("speech-10s.wav", 10.0), ("question-tts.wav", 8.53)]
RUNS    = 3
THREADS = 8

def parse(stderr):
    g = lambda k: (lambda m: float(m.group(1)) if m else None)(
        re.search(rf"{k}\s*=\s*([\d.]+)\s*ms", stderr))
    return g("load time"), g("total time")

rows, transcripts = [], {}
for model in MODELS:
    mp = f"models/ggml-{model}.bin"
    for clip, dur in CLIPS:
        infers, loads = [], []
        text = ""
        for _ in range(RUNS):
            p = subprocess.run(
                ["whisper-cli", "-m", mp, "-f", f"audio/{clip}", "-t", str(THREADS), "-nt"],
                capture_output=True, text=True)
            if p.returncode != 0:
                print(f"FAILED {model}/{clip}:\n{p.stderr[-500:]}", file=sys.stderr); sys.exit(1)
            load, total = parse(p.stderr)
            if total is None:
                print(f"could not parse timings for {model}/{clip}", file=sys.stderr); sys.exit(1)
            loads.append(load or 0.0)
            infers.append(total - (load or 0.0))
            text = p.stdout.strip()
        inf = statistics.median(infers)
        rows.append(dict(model=model, clip=clip, dur=dur,
                         load_ms=statistics.median(loads), infer_ms=inf,
                         rtf=inf / (dur * 1000)))
        transcripts[f"{model}/{clip}"] = text
        print(f"  {model:9s} {clip:18s} infer {inf:7.1f}ms  rtf {inf/(dur*1000):5.3f}", flush=True)

pathlib.Path("results.json").write_text(json.dumps(
    {"rows": rows, "transcripts": transcripts,
     "host": "Apple M2 Pro, 10 cores, 16GB", "threads": THREADS, "runs": RUNS}, indent=2))

print("\n" + "=" * 76)
print(f"{'model':10s} {'load':>9s} | " + " ".join(f"{c.replace('.wav',''):>16s}" for c, _ in CLIPS))
print("-" * 76)
for model in MODELS:
    mr = [r for r in rows if r["model"] == model]
    load = mr[0]["load_ms"]
    cells = " ".join(f"{r['infer_ms']:>10.0f}ms" + f"{r['rtf']:>6.2f}" for r in mr)
    print(f"{model:10s} {load:>7.0f}ms | {cells}")
print("=" * 76)
print("cells = inference ms (model resident) and real-time factor (lower is better)")
