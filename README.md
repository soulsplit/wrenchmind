# WrenchMind

> Chatbots talk about your engine. WrenchMind helps you fix it.

Built for the [Meta Global Hackathon](https://dev.meta.ai/events/global-hackathon).

What it does:

- Point the phone camera at an engine or piece of hardware and ask a plain question. You will get an augmented reality outline on the part and its name.
- Each identified part gets a repair card: steps with cautions, specs, tools, warnings, and manual/source links if found.
- Hands-free voice or chat style interaction.

**Live demo:** https://soulsplit.github.io/wrenchmind/

## Built with Meta AI

| Model | What it does in the app |
|---|---|
| SAM 3.1 | Draws the AR outlines: photo plus tap, circle, or voice target in, streamed mask out. |
| Muse Spark 1.3 | The thinking model: resolves which part a voice question means, names parts, reads label text, and writes repair steps grounded in the real manual. |
| Muse Voice Transcribe | Turns voice into text live over a realtime socket, hearing where each command ends. |

Request/response calls go through Meta's Chat Completions API; streaming
results (SAM masks, repair steps, transcription) arrive over the Responses
and realtime APIs. SAM requests are built with the `@meta-sam/parser`
helper library. All on-screen AR drawing, tracking, and highlighting is
custom code.

## Quickstart (local)

Requires Node.js 18 or newer. Get a Model API key at
[dev.meta.ai](https://dev.meta.ai/) first.

```sh
cp .env.example .env   # then set VITE_META_MODEL_API_KEY
npm ci
npm run dev            # http://localhost:5173/wrenchmind/
```

Point a tunnel at the dev server to expose it:

```sh
cloudflared tunnel --url http://localhost:5173
```

Open the printed `https://...trycloudflare.com/wrenchmind/` URL on the
phone (dev accepts `*.trycloudflare.com` hosts by default; set
`VITE_ALLOWED_HOSTS` to your exact tunnel hostname to narrow it). Or open that URL on the
desktop too and scan the in-app QR code (header menu) with the phone.

## Deploy

Pushing to `main` validates (lint, tests, build), then deploys `dist/` to
GitHub Pages at `https://soulsplit.github.io/wrenchmind/`. Before the first
push, add the repo secret `VITE_META_MODEL_API_KEY` at Settings →
Secrets and variables → Actions (the deploy job fails if it is missing),
and enable Pages with the **GitHub Actions** source in repo settings.

## Features

### See

- Full-viewport camera feed with transparent AR canvas
- Front/back camera switcher
- Flashlight toggle to bring light to dark places like under a car
- Freeze frame holds the feed still so you can circle or tap parts at your own pace
- Upload a photo with the (+) button: it freezes exactly like a camera still for tap-to-identify and circle-to-search
- Up to 4K and zoom to 4x
- Color-coded overlays (cyan = component, yellow = connector, red = fastener) with callout pills
- Overlays re-segment every 2 s so they track moving subjects
- Header badges: LIVE / NO FEED / FROZEN, front/rear camera, tracking lock,
  status, rotating hint pill, and the app version. Missing API key and
  camera/mic failures surface as plain-text errors with fixes.

### Ask

- Supports circle-to-search and tap-to-identify
- Voice mode toggle with continuous recognition via Meta Muse Voice Transcribe (realtime socket, model-detected turn ends); "done", "back",
  "repeat" step through the repair card hands-free. Once locked on, follow-ups answer by voice without re-marking.
- Prefer typing? The query bar runs the same pipeline as voice.

### Fix

- Repair guidance card: step n-of-m with Back / Next Step buttons, specs (always flagged "verify against the manual"), tools, a warnings slot
  that always renders, manual title, source links, and matching iFixit repair guides. "Scan Another Part" resets for the next part.

### Share

- One-tap HTML repair-report export (steps with progress and photos, specs, warnings, sources, session log) and an in-app log with copy/download.

| Script            | Purpose                               |
| ----------------- | ------------------------------------- |
| `npm run dev`     | Dev server with hot reload (`--host`) |
| `npm test`        | Vitest suite, single run              |
| `npm run lint`    | ESLint over the repo                  |
| `npm run build`   | Typecheck (`tsc -b`) + Vite build     |
| `npm run preview` | Serve `dist/` locally (`--host`)      |
| `npm run open`    | Build then serve `dist/` and open browser (`--host`) |

## Testing

`npm test` runs the Vitest suite once.

## API key exposure

`VITE_META_MODEL_API_KEY` is a `VITE_`-prefixed variable, so Vite embeds it
in the client bundle — every user receives the key. This is inherent to the
current client-only architecture (no server proxy). Mitigate by restricting
the key at the provider (referrer/origin allowlist, quota, rotation) and by
treating a leaked key as rotatable, not secret. Rotate or restrict the key
after the hackathon. `.env` (real key) and `dist/` (built bundle containing
the key) stay gitignored and must never be committed.
