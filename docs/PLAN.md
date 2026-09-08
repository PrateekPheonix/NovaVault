# Interview Copilot — Phased Delivery Plan

**Status:** Plan only. Nothing implemented.
**Source:** PRD — Real-Time AI Interview & Meeting Copilot
**Platform decision:** **macOS first**, Windows parity deferred to Phase 5
**Scope decision:** auth and billing **dropped** — internal tool, not a commercial product
**STT decision:** **`whisper.cpp`, local** — no vendor key, no per-hour cost, no audio leaves the machine
**OS floor:** **macOS 14.4+** — enables Core Audio process taps
**Date:** 2026-09-07

Phasing follows the PRD's own §61 Development Priority, mapped onto the §59 V0→V2
roadmap. Section refs (§n) point back to the PRD.

---

## Guiding principle (§63)

> **The pipeline is the MVP.** Billing, dashboard, question bank, mock interviews and
> analytics are secondary.

Build order is vertical-slice-first: one question, end to end, from the call into the
overlay before broadening anything.

Per §21 and §63, "undetectable to proctoring / Task Manager / Activity Monitor" is **not**
an engineering requirement. The requirement is the PRD's own wording: *the assistant UI
must remain private to the local user and should not appear in ordinary user-selected
screen-sharing of the work window, subject to OS/platform capture semantics.*

**Deviation from §47:** the PRD's MVP lists Windows **and** macOS. We are shipping macOS
first by choice. Audio capture and the overlay are the two most platform-specific pieces
in the system, so doing both platforms at once roughly doubles the hardest work. Windows
becomes Phase 5.

---

## Phase 0 — Decisions & the audio spike
*Days, not weeks. Blocks Phase 1.*

| Decision | Options (§) | Notes |
|---|---|---|
| Desktop shell | Electron vs Tauri (§23) | PRD recommends **Electron + TypeScript** for MVP, native modules later |
| ~~STT provider~~ | **DECIDED: `whisper.cpp`, local** (§9) | No procurement dependency; unblocks Phase 1 today. Streaming/partial-transcript behaviour is weaker than hosted STT and needs tuning against §30 |
| LLM providers | Abstraction over OpenAI / Anthropic / Google / local (§19) | Suggest `claude-opus-5` for strong/system-design, `claude-haiku-4-5` for the cheap classifier — behind the `LLMProvider` interface so this stays swappable |
| Backend | Java 21 / Spring Boot / Postgres / Redis / S3 (§50) | AI gateway as separate Python or Node service (§50) |
| ~~Minimum macOS version~~ | **DECIDED: 14.4+** | Core Audio process taps. Excludes macOS 13 and older |

### 🔴 Spike first: macOS system audio capture

§61 lists Phase 1 audio as **"Microphone"** only. But the product's value is hearing the
*interviewer*, whose voice arrives via **system audio**, not the mic. A mic-only V0 hears
only the user and cannot demonstrate the product. §8 already lists system audio as
required; it is the §61 ordering that understates it.

On macOS this is the single hardest piece of engineering in the plan, and the approach is
gated by the minimum OS version:

| Approach | Requires | Trade-off |
|---|---|---|
| **Core Audio process taps** (`AudioHardwareCreateProcessTap` + aggregate device) | macOS **14.4+** | Cleanest. No driver to install, no change to the user's audio output. **Recommended.** |
| **ScreenCaptureKit** (`SCStream` with audio) | macOS 13+ | Works, but needs **Screen Recording** permission just to capture audio — a heavy consent prompt for an audio feature |
| **Virtual audio device** (BlackHole / Loopback) | Any | Ships a kernel-adjacent driver, hijacks the user's default output device. Bad UX, bad install story. Avoid. |

**Decided: macOS 14.4+ with Core Audio process taps.**

### Spike result — `spikes/macos-audio-tap/`

Built and run. Every structural link works: tap creation, tap UID, private aggregate
device, format negotiation (48kHz/2ch/f32), IOProc delivering frames at real-time rate,
valid WAV out. Compiles under Command Line Tools alone — no full Xcode, no Swift, no
driver, and **no Screen Recording prompt**.

**Not yet proven: that the frames contain audio.** Every sample came back zero, because the
spike ran as a background agent process that holds no audio-capture permission and cannot
be shown a TCC prompt. Needs one manual run from Terminal to close out — see the spike
README.

### Spike result — `spikes/whisper-bench/`

Local `whisper.cpp` is **comfortably fast enough**, on an M2 Pro with the model resident:

| model | 10s question | RTF |
|---|---|---|
| `tiny.en` | 191ms | 0.02 |
| **`base.en`** | **208ms** | **0.02** |
| `small.en` | 462ms | 0.05 |

`base.en` uses ~7–20% of the §30 budget, leaving the rest for the LLM, with room to absorb
3–4× degradation from streaming and real-world audio. **Latency risk retired; the STT
decision holds. Default to `base.en`.**

**Accuracy is not established.** All models scored 0% WER, but only on a clean archival
recording and synthesised speech. VoIP compression, accents, cross-talk, technical jargon
and — most importantly — *streaming* rather than batch transcription are all untested. A
streaming benchmark on real interview audio should precede any Phase 1 chunking strategy.

> **⚠ Finding that changes Phase 1 requirements.** A missing audio-capture permission is a
> **silent failure, not an error**. Core Audio creates the tap, builds the device, and
> delivers a correctly-formatted stream of digital silence, with no `OSStatus` failure
> anywhere. Frame count is not proof of capture. The app must therefore detect all-zero
> capture itself and surface its own permission explanation — otherwise a user who denied
> the permission sees an app that looks healthy and simply never answers anything.

### Also in Phase 0

- Apple Developer Program enrolment — Developer ID cert has lead time and blocks
  distribution (§55)
- Decide universal binary (arm64 + x86_64) vs arm64-only

**Exit:** audio spike proves system-audio capture on the target OS floor; providers chosen
against a measured latency/cost test; Developer ID cert requested.

---

## Phase 1 — V0 prototype: the vertical slice (macOS)
*§59 estimate: 1–2 weeks. §61 Phase 1.*

```text
Audio → Streaming STT → Question Detect → LLM → Streaming Answer → Overlay
```

Scope:
- Electron shell, menu-bar item, global keyboard shortcuts (§47)
- Audio capture: **system audio + microphone**, per the Phase 0 spike (§8)
- **Silent-capture detection** — measure signal, not frame count; drive a first-run
  permission explainer off it (see the Phase 0 finding)
- Streaming STT with VAD (§9)
- Question detector — **do not send every partial transcript to the LLM**; wait for a
  complete question before triggering generation (§9, §10)
- `LLMProvider` interface + one concrete provider (§19)
- Token-level streaming into the overlay (§20)
- Answer formatting per §5 — terse: approach / complexity / edge case, not an essay (§G5)

### macOS specifics to get right in Phase 1

- **TCC permissions** — Microphone (`NSMicrophoneUsageDescription`), plus Input Monitoring
  or Accessibility for global hotkeys. Each is a separate user prompt; sequence them so the
  app explains itself before triggering the OS dialog.
- **Overlay window** — Electron `BrowserWindow` with `alwaysOnTop`, an elevated window
  level, and `setVisibleOnAllWorkspaces`. Backed by an `NSPanel` if Electron's behaviour
  proves insufficient (§21).
- **Window privacy** — Electron's `setContentProtection(true)` maps to
  `NSWindow.sharingType = .none`. This is the OS-sanctioned mechanism for the PRD's stated
  privacy requirement and the macOS analogue of the `SetWindowDisplayAffinity` reference in
  §21. It is a documented AppKit API, not an evasion technique.

**Exit:** a question spoken by another participant produces a useful, streamed answer in
the overlay.

---

## Phase 2 — Context
*§61 Phase 2. Part of §59 V1.*

- Resume upload, JD upload, session instructions (§G3, §11)
- Context architecture and assembly (§12)
- Conversation memory + follow-up understanding (§17)
- Prompt architecture (§32)
- Response strategy per interview type — DSA / system design / behavioural / resume (§18)

**Exit:** "Tell me about a production incident you handled" produces an answer grounded in
the user's actual resume.

---

## Phase 3 — Screen, vision, coding mode
*§61 Phase 3. Completes §59 V1 / V1.5.*

- Screen understanding + screenshot pipeline on meaningful screen change (§13, §14)
- Vision/OCR for code and diagrams (§13)
- Coding mode: question + current code + language + history → approach, complexity, edge
  cases, code (§15, §G4)
- Manual and screen-context controls for when auto-detection fails (§33, §35)

**macOS note:** this phase is where **Screen Recording** permission finally becomes
unavoidable. Deferring it to Phase 3 (by using Core Audio taps in Phase 1) means the V0
demo doesn't have to ask for it.

**Exit:** a coding question on screen yields approach + complexity + working code.

---

## Phase 4 — AI gateway, distribution & cost control
*Reduced scope: auth and billing dropped.*

**Out:** billing tiers (§44), subscription state, entitlements, and the §56 consumer
anti-abuse surface (device registration, credit manipulation, fake clients). No paying
users and no untrusted public clients means none of that earns its keep.

**Still needed, and why:**

- Session and document storage (§25, §28); session state machine (§29)
- Streaming API / WebSocket protocol (§51, §52)
- Cost architecture and model routing (§45, §46) — reframed from *billing* to *internal
  spend control*. Routing a cheap classifier ahead of a strong model matters more when you
  pay the provider bill directly and no one is reimbursing it.
- Code signing, notarization, secure auto-update (§55) — these are **distribution**
  requirements, not commercial ones. Unchanged.

### ⚠ "Skip auth" is not "skip backend" — API key custody

§55's rule *don't trust the client* survives for one specific reason: **provider API keys.**

An Electron app is trivially unpacked — `.asar` is an archive format, not encryption. Any
STT or LLM key shipped in the bundle is effectively readable by anyone who has the app, and
a leaked key is billed at provider rates until someone notices and rotates it. Being an
internal tool reduces the blast radius; it does not remove it.

| Option | Fits | Trade-off |
|---|---|---|
| **Thin backend proxy** holds the keys; clients authenticate via existing SSO or a simple signed token | More than a handful of users | Keeps a small service alive, but with no entitlements, no subscription state, no billing reconciliation — just key custody, rate limiting and usage visibility |
| **Per-user provider keys** entered in local settings | Small internal pilot | No backend at all; each user's spend sits on their own key. Simplest possible, but no central cost visibility or kill switch |

Recommend the proxy if this outgrows a pilot. It is a small fraction of the §47 backend —
the expensive parts of that section were exactly the ones we just dropped.

### Distribution — likely forced to direct download

The **Mac App Store is probably not viable**. MAS requires the App Sandbox, which is hard
to reconcile with system-audio capture, an always-on floating overlay, and self-managed
auto-update. Plan for **direct download**: Developer ID signing, hardened runtime, the
audio-input entitlement, notarization and stapling, and a self-hosted update channel.
For an internal tool this is easier, not harder — distribution can be an internal link,
and MDM can handle install.

> **The §47 vs §61 ordering tension dissolves.** It existed because §47 made auth and
> billing part of the MVP while §61 built them last. With both dropped, there is no
> commercial ship gate: an internal build is releasable once Phase 3 lands, and Phase 4
> becomes a thin supporting layer rather than a milestone to clear.

## Phase 5 — Windows parity
*Deferred from §47 by the macOS-first decision.*

- System audio via **WASAPI loopback** — substantially easier than the macOS equivalent
- Overlay via Win32; `SetWindowDisplayAffinity` for the §21 privacy requirement
- Windows code signing, installer, auto-update

**Can run in parallel with Phase 4** given a second desktop engineer — the two touch almost
entirely separate code. That parallelism is the main argument for the §60 team shape.

**Exit:** feature parity with the macOS client at the Phase 3 boundary.

---

## Phase 6 — Depth features
*§61 Phase 5 / §59 V1.5–V2.*

- Post-interview analysis (§40)
- Mock interview mode (§42)
- Question bank (§43)
- Session history and transcripts (§39)
- Dashboard (§41) — deliberately last, per §63
- V2: advanced RAG (§27), company-specific prep, interview scoring, personalised prep (§59)

---

## Cross-cutting tracks

Not phases — these run continuously from Phase 1.

- **Reliability (§53):** defined degradation for internet drop, STT failure, LLM provider
  failure, backend failure, accidental overlay close
- **Observability (§54)**
- **Privacy (§36–38):** privacy architecture, encryption, user-facing privacy settings.
  Default posture matters — this app hears entire conversations, and on macOS the TCC
  prompts make that visible to the user whether or not the product explains it well
- **Latency budget (§30, §31):** ~1–3s from end-of-question to first token (§G1); track as
  a metric from Phase 1, not a Phase 4 optimisation

---

## Team (§60)

1 desktop · 1 backend · 1 AI · 1 frontend engineer.

Phase 1 is desktop + AI heavy. Backend and frontend have little critical-path work until
Phase 4 — stagger their start, or lend them to the Phase 0 audio spike. A second desktop
engineer is what makes Phase 5 parallelisable.

---

## Open questions

**Resolved:** macOS-first · macOS 14.4+ floor · `whisper.cpp` / `base.en` for STT
(benchmarked) · auth/billing dropped · latency a target measured from Phase 1 · arm64-only.

1. **Finish the audio spike under a granted permission** — one manual run from Terminal.
   Still the only unproven link in the capture chain, and it gates Phase 1.
2. **Validate STT accuracy on real interview audio, streaming** — latency is settled,
   accuracy is not. Needs real recordings; ideally with the accents this will run against.
3. **API key custody** — thin proxy or per-user keys? Only an *LLM* key is needed now.
   Depends on user count and whether central cost visibility is wanted.
4. **Roughly how many internal users?** Decides Q3 and how much of Phase 4 survives.
5. **Apple Developer Program enrolment** — the only signing identity here is
   `Apple Development`, which cannot sign for distribution. Needed before Phase 4; has
   lead time.
