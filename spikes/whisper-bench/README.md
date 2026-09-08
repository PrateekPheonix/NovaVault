# Phase 0 spike — is local `whisper.cpp` fast enough?

## The question

We chose local `whisper.cpp` for STT to avoid vendor procurement. That decision is only
sound if it fits the PRD's §30 budget: **~1–3s from end-of-question to first token of the
answer**, of which STT is one leg (the LLM call is the other, larger one).

If local Whisper couldn't hit that, the STT decision reverses and we're back to a hosted
vendor. Hence this spike.

## Method

- Host: **Apple M2 Pro, 10 cores, 16GB**, `whisper-cli` (Homebrew, Metal enabled), 8 threads
- Models: `tiny.en`, `base.en`, `small.en`
- Audio: real human speech (`jfk.wav`, sliced to 3s/5s/10s) + a synthesised interview
  question (8.5s)
- 3 runs per cell, median reported
- **Model load time is subtracted.** A real app loads once at startup and keeps the model
  resident; `whisper-cli` reloads per invocation, so wall clock would overstate badly.

Reproduce: `python3 bench.py` (writes `results.json`).

## Results — inference ms, model resident

| model | load | 3s | 5s | 10s | 8.5s question | RTF |
|---|---|---|---|---|---|---|
| `tiny.en`  | 52ms  | 77ms  | 75ms  | **191ms** | 177ms | 0.02 |
| `base.en`  | 82ms  | 131ms | 115ms | **208ms** | 242ms | 0.02–0.03 |
| `small.en` | 226ms | 444ms | 281ms | **462ms** | 425ms | 0.05 |

RTF = real-time factor. `base.en` transcribes 10 seconds of speech in ~0.21 seconds.

## Verdict: latency risk retired, with a wide margin

A 10s interview question transcribes in **~208ms on `base.en`** — roughly 7–20% of the
1–3s budget, leaving the rest for the LLM. Even `small.en` at ~462ms leaves over a second.
There is enough headroom to absorb 3–4× degradation from streaming overhead and messier
real-world audio and still fit.

**Recommendation: `base.en` as the default.** `tiny.en` is barely faster and less robust;
`small.en` costs ~2× the latency for accuracy we cannot yet measure. Model load (82ms) is
a startup cost, not a per-utterance one.

## ⚠ What this does NOT establish

All three models scored **0% WER** on both clips — which says more about the test material
than the models. `jfk.wav` is a famously clean recording and the question clip is
synthesised speech. **This is not evidence of real-world accuracy.**

Untested, and all of it harder than what was measured:

- VoIP/codec compression from Zoom, Meet, Teams
- Accents, and the Indian-English accents this will actually run against
- Cross-talk and interruption — two speakers at once
- Background noise, poor microphones
- Technical vocabulary: algorithm names, library names, "big O", system-design jargon
- **Streaming**, rather than batch transcription of a complete clip. This is the real gap —
  §9 requires partial transcripts and end-of-question detection, and sliding-window
  streaming has materially different accuracy and latency characteristics from what was
  measured here.

The latency question is answered. The accuracy question needs real interview recordings,
and a streaming benchmark needs to happen before Phase 1 commits to a chunking strategy.
