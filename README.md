# WrenchMind

> They talk about your engine. WrenchMind helps you to fix it.

Built for the [Meta Global Hackathon](https://dev.meta.ai/events/global-hackathon).

What it does:

- Point the phone camera at an engine or piece of hardware and ask a plain question. You will get an augmented reality outline on the part and its name.
- Each identified part gets a repair card: steps with cautions, specs, tools, warnings, and manual/source links if found.
- Hands-free voice or chat style interaction.

**Live demo:** https://soulsplit.github.io/wrenchmind/

## Quickstart (local)

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

## Run from GitHub

Pushing to `main` validates (lint, tests, build), then deploys `dist/` to
GitHub Pages at `https://<you>.github.io/wrenchmind/`. Before the first
push, add the repo secret `VITE_META_MODEL_API_KEY` at Settings →
Secrets and variables → Actions (the deploy job fails if it is missing),
and enable Pages with the **GitHub Actions** source in repo settings.

## Features

- Full-viewport camera feed with transparent AR canvas
- Front/back camera switcher
- Flashlight toggle to bring light to dark places like under a car
- Freeze frame holds the feed still so you can circle or tap parts at your own pace
- Supports circle-to-search and tap-to-identify
- Up to 4K and zoom to 4x
- Color-coded overlays (cyan = component, yellow = connector, red = fastener) with callout pills
- Overlays re-segment every 2 s so they track moving subjects
- Voice mode toggle with continuous recognition via Meta Muse Voice Transcribe (realtime socket, model-detected turn ends); "done", "back",
  "repeat" step through the repair card hands-free. Once locked on, follow-ups answer by voice without re-marking.
- Repair guidance card: step n-of-m with Back / Next Step buttons, specs (always flagged "verify against the manual"), tools, a warnings slot
  that always renders, manual title, source links, and matching iFixit repair guides. "Scan Another Part" resets for the next part.
- One-tap HTML repair-report export (steps with progress and photos, specs, warnings, sources, session log) and an in-app log with copy/download.
- Header badges: LIVE / NO FEED / FROZEN, front/rear camera, tracking lock,
  status, rotating hint pill, and the app version. Missing API key and
  camera/mic failures surface as plain-text errors with fixes.

| Script            | Purpose                               |
| ----------------- | ------------------------------------- |
| `npm run dev`     | Dev server with hot reload (`--host`) |
| `npm test`        | Vitest suite, single run              |
| `npm run lint`    | ESLint over the repo                  |
| `npm run build`   | Typecheck (`tsc -b`) + Vite build     |
| `npm run preview` | Serve `dist/` locally (`--host`)      |
| `npm run open`    | Build then serve `dist/` and open browser (`--host`) |

## Testing

`npm test` runs the Vitest suite once. For device testing, use the HTTPS
tunnel above or the Pages deploy — never plain-HTTP LAN. If a permission
was previously blocked for the site, the browser will not prompt again;
re-enable it in the browser's site settings. Where speech recognition is
unavailable, the text query bar is the fallback.

## API key exposure

`VITE_META_MODEL_API_KEY` is a `VITE_`-prefixed variable, so Vite embeds it
in the client bundle — every user receives the key. This is inherent to the
current client-only architecture (no server proxy). Mitigate by restricting
the key at the provider (referrer/origin allowlist, quota, rotation) and by
treating a leaked key as rotatable, not secret. `.env` (real key) and `dist/`
(built bundle containing the key) stay gitignored and must never be
committed.
