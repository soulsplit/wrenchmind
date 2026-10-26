# WrenchMind PWA

Hands-free AR mechanical diagnostic assistant. Technicians ask natural spatial
questions ("Show me the blend door", "Where is the electrical connection?")
while working. The app streams the device camera plus continuous voice,
isolates target features via Meta SAM 3.1, reasons via Meta Muse Spark, and
responds with visual overlays and voice synthesis.

## Features

- Full-viewport camera viewfinder with transparent AR canvas and front/back
  camera switcher (auto-hidden on single-camera devices)
- Continuous voice loop with exponential-backoff restarts, plus a text query
  bar that runs the same pipeline (noisy shops, unsupported browsers)
- Multi-frame bursts per query and a re-segmentation loop so highlights track
  moving subjects
- Neon-coded overlays (cyan = components, yellow = connectors, red =
  fasteners/screws) with floating callout pills and brief voice confirmations
- In-app log with copy/download, QR code sharing of the hosted URL, and
  precise camera/microphone failure diagnostics

## Stack

- React 18 + Vite + TypeScript (strict) + Tailwind CSS
- Meta Model API: `muse-spark-1.3` (reasoning), `sam-3.1` (segmentation)
  parsed with the official `@meta-sam/parser` library
- Browser APIs only: `getUserMedia`, `SpeechRecognition` /
  `webkitSpeechRecognition`, `speechSynthesis`, `fetch`
- No custom backend. Tests with Vitest + Testing Library + happy-dom.

## Develop

```sh
cp .env.example .env   # then set VITE_META_MODEL_API_KEY
npm ci
npm run dev            # http://localhost:5173/wrenchmind/
```

| Script        | Purpose                              |
| ------------- | ------------------------------------ |
| `npm run dev` | Dev server with hot reload           |
| `npm test`    | Vitest suite (once, no watch)        |
| `npm run lint`| ESLint over the repo                |
| `npm run build` | Typecheck (`tsc -b`) + production build |
| `npm run preview` | Serve `dist/` locally              |

## Deploy

Pushing to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml` (builds with `npm ci`, runs tests, uploads
`dist/`). The app is served from the `/wrenchmind/` base path. For a first
push from this checkout:

```sh
git remote add origin git@github.com:<you>/wrenchmind.git
git push -u origin main
```

then enable Pages with the **GitHub Actions** source in the repo settings.

## How it works

1. `Scanner` shows the rear camera full-viewport with a transparent AR canvas.
   The canvas shares the video's `object-cover` geometry, so frame-pixel masks
   stay aligned with the feed. The Switch camera button flips facing (hidden
   when only one camera exists) and clears the stale overlay.
2. Enabling the voice toggle starts a continuous recognition loop
   (`voiceAssistant`) with exponential-backoff restarts and a bounded retry cap.
   The bottom query bar (`QueryBar`) sends typed text through the same pipeline.
3. Each phrase captures a burst of frames (`FRAME_BURST = 3`, 300 ms apart) and
   sends them with the phrase plus rolling memory (recent commands + resolved
   labels/coords) to Muse Spark, which returns `{ target_label, approx_x,
   approx_y, speech_response, display_mode }`.
4. The latest frame goes to SAM 3.1 with a point prompt in the documented
   token grammar (or the bare noun phrase when the position is unknown).
   Boxes shrink to the tight bounds of set mask pixels before rendering.
5. While an overlay is active, the latest frame is re-segmented every 2 s
   (`REFRESH_INTERVAL_MS`) so the highlight tracks moving subjects. The loop
   pauses during analysis and stops on Clear, camera switch, voice-off, or
   unmount.
6. `visual_only` and `speech_response: null` stay silent; `speech_and_visual`
   also speaks a brief confirmation. "Clear AR View" erases masks and memory.
7. The **QR** button (top left) shows a scannable code for the current page URL
   with a warning when the URL isn't phone-reachable (localhost/HTTP).

## Project layout

```text
src/
  components/   Scanner, StatusBar, Toggle, QueryBar, LogPanel, QrShare
  services/     metaApi, samParser, voiceAssistant, logger, mediaSupport
  types.ts      Shared result/mask/status types
```

## Mobile testing

Camera and microphone require a secure context: mobile browsers never prompt
on plain `http://` LAN URLs, so `vite --host` alone is not enough. Use one of:

- Deploy to GitHub Pages (HTTPS, stable, installable), or
- Point a tunnel at the dev server, e.g. `cloudflared tunnel --url
  http://localhost:5173`, and open the printed `https://` URL on the phone
  (dev allows `*.trycloudflare.com` hosts).

Then open the phone-reachable URL in the desktop browser too and scan the
in-app QR code to open the same page on the phone.

Notes: iOS Safari has no SpeechRecognition, so voice is unavailable there —
the text query bar is the fallback. If a permission was previously blocked for
the site, the browser won't prompt again; the app says so and it must be
re-enabled in the browser's site settings.

## Debugging

The **Logs** button (top left) opens a live in-app log with Copy, Download
(`wrenchmind-<timestamp>.log`), and Clear actions. Entries also mirror to the
browser devtools console. Logged events include camera selection/failures,
voice lifecycle and restart backoff, phrase pipeline stages with box spans,
and API errors with HTTP statuses and server messages. API keys and image
payloads are never logged.

## Security & privacy

- The Meta API key is read only from `import.meta.env.VITE_META_MODEL_API_KEY`
  and is never hardcoded or logged. `.env` is git-ignored; never commit it.
- Note: this is a client-side PWA, so the key is necessarily exposed to the
  browser. Treat it as a publishable key, scope/restrict it server-side where
  possible, and rotate it if abused.
- Camera and microphone are requested explicitly; denials surface as visible
  error states with actionable diagnostics.
