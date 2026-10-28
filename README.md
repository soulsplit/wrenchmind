# WrenchMind PWA

> They talk about your engine. WrenchMind points at it.

What it does:

- Point the phone camera at an engine, ask a plain question ("show me the
  blend door"), get an AR outline on the part plus a short spoken answer.
- Each identified part gets a repair card: steps with cautions, specs, tools,
  warnings, and manual/source links.
- Hands-free voice loop with a typed query bar that runs the same pipeline.

## Quickstart (local)

```sh
cp .env.example .env   # then set VITE_META_MODEL_API_KEY
npm ci
npm run dev            # http://localhost:5173/wrenchmind/
```

Phone testing: camera and mic need HTTPS or localhost, so plain LAN HTTP
never prompts. Point a tunnel at the dev server:

```sh
cloudflared tunnel --url http://localhost:5173
```

Open the printed `https://...trycloudflare.com/wrenchmind/` URL on the
phone (dev accepts `*.trycloudflare.com` hosts). Or open that URL on the
desktop too and scan the in-app QR code (header menu) with the phone.

## Run from GitHub

Pushing to `main` validates (lint, tests, build), then deploys `dist/` to
GitHub Pages at `https://<you>.github.io/wrenchmind/`. Before the first
push, add the repo secret `VITE_META_MODEL_API_KEY` at Settings →
Secrets and variables → Actions (the deploy job fails if it is missing),
and enable Pages with the **GitHub Actions** source in repo settings.

## Features

- Full-viewport camera feed with transparent AR canvas; front/back switcher
  hides itself on single-camera devices, and a flashlight toggle appears
  when the camera track reports torch support. Freeze frame stills the
  feed for circle-to-search (drag to circle a part) and tap-to-identify
  without re-segmentation. Identification retries a wide-context crop when
  the tight crop is unnamed, and prefers a generic category over "unknown".
  The feed negotiates up to 4K and zooms to 4x (pinch, mouse wheel)
  on live and frozen frames; taps stay accurate while zoomed.
- Color-coded overlays (cyan = component, yellow = connector, red =
  fastener) with callout pills; plural queries ("all the bolts") isolate
  every instance with numbered outlines. Overlays re-segment every 2 s so
  they track moving subjects.
- Voice mode toggle with continuous recognition; "done", "back", "repeat"
  step through the repair card hands-free. Once locked on, follow-ups
  answer by voice without re-marking.
- Repair guidance card: step n-of-m with Back / Next Step buttons, specs
  (always flagged "verify against the manual"), tools, a warnings slot
  that always renders, manual title, source links, and matching iFixit
  repair guides. "Scan Another Part" resets for the next part.
- One-tap HTML repair-report export (steps with progress and photos,
  specs, warnings, sources, session log) and an in-app log with copy/download.
- Header badges: LIVE / NO FEED, front/rear camera, tracking lock, and
  status. Missing API key and camera/mic failures surface as plain-text
  errors with fixes.

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
