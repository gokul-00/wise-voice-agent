# Wise Voice Agent — LiveKit

A real-time voice AI for Wise customer support, built on [LiveKit Agents](https://docs.livekit.io/agents/). It handles the "Where is my money?" FAQ section via voice, and gracefully transfers callers to a human agent for anything out of scope.

---

## What it does

- Answers questions about Wise transfer status using a structured FAQ knowledge base
- Asks a clarifying question before escalating, so the caller always understands why they're being transferred
- Calls `transfer_to_human` as a function tool, says a warm goodbye, then disconnects the room
- Streams audio end-to-end: STT → LLM tokens → TTS audio, all incrementally
- Tracks per-turn latency (TTFT, TTFA), barge-in rate, fallback activations, and STT correction proxies

---

## Architecture

```
Caller audio
    │
    ▼
Deepgram nova-3 (STT, streaming)          ← fallback: OpenAI gpt-4o-transcribe
    │  transcript tokens
    ▼
Silero VAD  +  MultilingualModel (EOU)    ← end-of-utterance detection
    │  user turn complete
    ▼
OpenAI gpt-4.1-mini (LLM, streaming)     ← fallback: Google gemini-2.5-flash
    │  token stream
    ▼
OpenAI tts-1 / nova (TTS, streaming)     ← fallback: Deepgram TTS
    │  audio chunks
    ▼
Caller speaker
```

Preemptive generation is enabled — TTS begins rendering the opening words before the full LLM response is ready, keeping time-to-first-audio under ~600 ms on typical turns.

---

## Setup

**Requirements:** Python 3.12+, [uv](https://docs.astral.sh/uv/)

### 1. Install dependencies

```bash
cd livekit-voice-agent
uv sync
```

### 2. Configure environment

Create `.env.local` in this directory:

```env
LIVEKIT_URL=wss://<your-project>.livekit.cloud
LIVEKIT_API_KEY=<your-api-key>
LIVEKIT_API_SECRET=<your-api-secret>

OPENAI_API_KEY=<your-openai-key>
DEEPGRAM_API_KEY=<your-deepgram-key>
GOOGLE_API_KEY=<your-google-key>          # optional — used as LLM fallback
```

> The FAQ knowledge base is loaded from `../faq_knowledge.json` (the parent directory). Make sure that file exists before running.

### 3. Run

**Console mode** (test locally with your microphone):

```bash
uv run agent.py console
```

**Connect to a LiveKit room** (production / playground):

```bash
uv run agent.py start
```

---

## Agent behaviour

### In-scope topics (handled directly)

All sourced from the Wise "Where is my money?" help section:

| Topic | FAQ ID |
|---|---|
| How to check transfer status | `check_transfer_status` |
| When will my money arrive | `when_money_arrive` |
| Transfer complete but money not received | `transfer_complete_not_arrived` |
| Transfer taking longer than estimated | `transfer_taking_longer` |
| What is a proof of payment | `proof_of_payment` |
| Banking partner reference number | `banking_partner_reference` |

### Out-of-scope escalation flow

When a caller asks about anything outside the above topics (wrong recipient, refunds, cancellations, fees, account settings, etc.):

1. **Clarify** — agent confirms what the caller is asking
2. **Acknowledge** — agent explains warmly that it can't help with this directly
3. **Transfer** — `transfer_to_human()` is called; agent says a goodbye and the room disconnects

The agent never skips straight to a transfer and never guesses answers from general knowledge.

---

## Latency tuning

| Stage | Configuration | Typical latency |
|---|---|---|
| VAD end-of-turn | `min_silence_duration=0.3s` | ~300 ms after user stops |
| STT transcript | Deepgram nova-3, streaming | ~65–400 ms |
| LLM first token | gpt-4.1-mini, streaming | ~700–950 ms |
| TTS first audio | tts-1, streaming | ~300–600 ms |
| **Total TTFA** | EOU → first audio frame | **target < 1000 ms** |

Any turn that exceeds 1000 ms TTFA is logged as a warning.

---

## Metrics logged per turn

| Metric | Log label |
|---|---|
| End-of-utterance delay + transcription delay | `EOU` |
| LLM time-to-first-token | `TTFT` |
| TTS time-to-first-byte | `TTS TTFB` |
| Time-to-first-audio (EOU → speaker) | `TTFA` |
| User barge-in rate | `BARGE-IN` |
| AEC false interruptions | `FALSE INTERRUPTION` |
| STT correction proxies | `STT CORRECTION PROXY` |
| Tool call outcomes | `TOOL <name> OK/FAILED` |
| Fallback activations | `LLM/STT/TTS FALLBACK` |
| Pipeline errors | `PIPELINE ERROR` |

A full session summary is printed on shutdown.

---

## Project structure

```
livekit-voice-agent/
├── agent.py          # main agent — all pipeline and metrics logic
├── pyproject.toml    # dependencies (uv)
├── .env.local        # secrets (not committed)
└── README.md

../
└── faq_knowledge.json   # FAQ source of truth (shared with web app)
```
