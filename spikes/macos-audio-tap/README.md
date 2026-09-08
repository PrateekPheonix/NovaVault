# Phase 0 spike — macOS system-audio capture via Core Audio process taps

## What this de-risks

The plan's highest schedule risk: can we hear the **other participant** in a call without
shipping a virtual audio driver, and without demanding Screen Recording permission in V0?

PRD §61 lists Phase 1 audio as "Microphone" only, but the mic hears the *user*, not the
interviewer. The interviewer's voice arrives as system audio.

## Build & run

```bash
./build.sh                       # needs only Xcode Command Line Tools
./audiotap [seconds] [out.wav]   # defaults: 10s, ./capture.wav
```

Exit codes: `0` real audio captured · `2` no frames · `3` frames but all silent.

## Status

| Link in the chain | Verified |
|---|---|
| `AudioHardwareCreateProcessTap` on a global tap | ✅ |
| Reading `kAudioTapPropertyUID` | ✅ |
| Private aggregate device wrapping the tap | ✅ |
| Format negotiation (48kHz, 2ch, f32) | ✅ |
| IOProc delivering frames at real-time rate | ✅ (5.01s of frames in 5s) |
| WAV written, correct duration and format | ✅ |
| **Frames containing actual audio** | ❌ **unverified — all zeros** |

Built and ran under Xcode Command Line Tools only. No full Xcode, no Swift, no driver, and
no Screen Recording permission requested.

## The finding that matters

**A missing audio-capture permission is a silent failure, not an error.**

Core Audio happily creates the tap, builds the aggregate device, and delivers a
correctly-formatted stream at exactly the right frame rate — made entirely of digital
silence. No `OSStatus` anywhere in the chain reports a problem.

The first version of this spike printed `SUCCESS` because it only checked frame count.
That is the trap: **frame count is not proof of capture.** It now measures signal peak and
reports `INCONCLUSIVE` on all-zero audio.

### Consequence for Phase 1

The desktop app must detect silent capture itself and surface its own permission
explanation. It cannot rely on an API error, because there isn't one. A user who denies the
permission would otherwise see an app that looks like it is working and simply never
answers a question.

## Why it read silent here

This ran as a background agent process under Conductor.app, which has not been granted
system-audio-recording permission and cannot receive an interactive TCC prompt. TCC
attributes the request to the responsible parent app, not to the `audiotap` binary.

## To finish the spike

Run it from Terminal.app, where a prompt can actually be answered:

```bash
cd spikes/macos-audio-tap
./audiotap 10 /tmp/test.wav        # play a video or join a call while it runs
```

Grant the permission under **System Settings → Privacy & Security → Screen & System Audio
Recording**, then re-run. Expect a moving level meter and exit code `0`.

If it still reads silent *with* permission granted and audio genuinely playing, that is a
real negative result and the tap approach needs re-examination before Phase 1 starts.
