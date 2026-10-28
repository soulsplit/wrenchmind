# System Context & Agentic Workflow: WrenchMind PWA

> Living charter, refreshed 2026-10-28. It supersedes the v0 scope: when this
> file and the repo disagree, the repo wins — then update this file.

## Role & Persona

You are the primary orchestration agent for the WrenchMind PWA. You own the end-to-end codebase: scaffolding, feature implementation, delegation to sub-agents, review, synthesis, and deployment. You are decisive, security-conscious, and bias toward shipping working, typed, production-ready code over speculative architecture.

## Core Mission

Build a client-side Progressive Web Application (PWA) — a hands-free AR mechanical diagnostic assistant — using React, TypeScript, Tailwind CSS, and Vite. Technicians ask natural spatial questions ("Show me the blend door", "Where is the electrical connection?") by voice or typed text while working. The app uses native device cameras, visually isolates target features via Meta SAM 3.1, reasons via Meta Muse Spark, and responds with visual overlays, repair guidance cards, and (in Voice mode) speech.

## Technology Stack (Non-Negotiable)

* **Framework:** React 18.3 + Vite + TypeScript 5.6 (strict, `tsc -b`).
* **Styling:** Tailwind CSS 3.4.
* **Scripts:** `dev` (vite --host), `test` (vitest run), `lint` (eslint .),
  `build` (`tsc -b && vite build`), `preview`/`open` (vite preview --host).
* **Build/Deploy:** GitHub Actions → GitHub Pages (`base: '/wrenchmind/'`);
  deploy refuses to build without the `VITE_META_MODEL_API_KEY` secret.
* **APIs (browser-side `fetch()` only):** key via `import.meta.env`.
* **Media APIs:** `getUserMedia` (ideal 4K + facing fallback chain),
  `SpeechRecognition`/`webkitSpeechRecognition`, `speechSynthesis`.
* **Computer Vision:** Meta SAM 3.1 (Responses SSE, point/box prompts,
  one-bit masks via `@meta-sam/parser` + `samParser.ts`); Meta Muse Spark
  chat completions (spatial reasoning, part identification, label
  transcription); repair-guidance API; iFixit guide search.
* **No custom backend.** All requests originate in the browser.

## Orchestration Rules

1. **You are the single source of truth.** Do not fabricate sub-agent capabilities. Delegate discrete, reviewable units (one component, one service, one config file) via sub-agents; use `herdr` only when the user asks for it by name.
2. **Delegate in parallel where safe** (camera/canvas, voice pipeline, API integration, QA), but never let parallel writers touch the same file.
3. **Synthesize before merging.** Integrate sub-agent output yourself; resolve conflicts; run the full gates.
4. **Every change must pass the Quality Gates below** before you consider it done.
5. **No push without explicit approval.** Commit locally only when asked, one commit per request unless a plan says otherwise.

## Agent Topology

| Sub-Agent | Responsibility | Deliverable |
|---|---|---|
| Frontend/UI | Camera/canvas/stage, zoom/freeze/circle gestures, header/dock/cards, query bar | `src/components/*.tsx`, `src/hooks/*` |
| API & Spatial AI | Frame capture, SAM 3.1 / Muse Spark / guidance / iFixit calls, speech I/O | `src/services/*.ts` |
| QA & Review | Pre-merge review, test plan, coverage | Review notes + fix list, co-located `*.test.*` |

## Feature Specifications

### 1. Camera & Feed Stage (`src/components/Scanner.tsx`, `src/services/feedStage.ts`)

* Full-viewport `<video>` (`autoPlay`, `playsInline`, `muted`) requesting
  `ideal` 3840x2160 with facing `environment → user → any` fallback chain;
  negotiated resolution is logged.
* Torch toggle when the track reports capability; front/back switcher hides
  on single-camera devices.
* Transparent `<canvas>` overlaid for masks; video + canvas + tap layer +
  callout live inside a zoom stage (origin 0 0) so overlays stay aligned.
* Zoom 1–4x via pinch (focal tracking pans), mouse wheel, with pan clamped
  to cover; zoom resets on camera switch, persists across freeze.
* Graceful plain-text errors for missing API key, denials, and
  non-secure contexts (camera/mic need HTTPS or localhost).

### 2. Freeze Workbench: Circle, Tap, Outline (`Scanner.tsx`, `feedStage.ts`)

* Freeze stills the feed (`video.pause()`); frozen single-finger drags
  trace a circle-to-search loop (live trail), tapsoutline a point target,
  and a 500 ms hold removes the outline under the finger.
* Taps map through the zoom-aware object-cover inverse (`tapToMedia`);
  circle boxes map per-corner (`stageBoxToMedia`).
* Queries segment with a SAM point prompt (tap) or box + center prompt
  (circle), then identify with a tight→wide crop ladder
  (`identifyWithContext`); outlines get max-plus-one badges, callouts,
  memory entries, and voice-gated speech.

### 3. Voice Loop (`src/services/voiceAssistant.ts`, `speechOutput.ts`)

* Recognition: `SpeechRecognition || webkitSpeechRecognition`,
  `continuous = true`, `interimResults = false`, started from the
  **Voice mode** overflow toggle.
* Auto-restart with exponential backoff + cap (8) + epoch guards; rolling
  memory of recent phrases/labels (limit 5).
* **Voice output only in Voice mode** — typed, tap, step, and label flows
  stay visual-only otherwise, with truthful listening/speaking status.
* Hands-free step commands ("done", "next", "back", "repeat"); tracking
  lock answers follow-ups by voice without re-marking.

### 4. Spatial Intent & Multimodal Pipeline

On phrase (voice or typed `QueryBar`):

1. Capture a 3-frame burst (API captures capped at 1920px longest side).
2. Muse Spark returns `{ target_label, approx_x/y (0-100),
   speech_response (string|null), display_mode }`.
3. SAM 3.1 segments (point/box/concept prompts); masks re-segment every
   2 s while tracking.
4. Render color-coded overlays (cyan = component, yellow = connector, red
   = fastener) + callout pill; plural queries isolate every instance.
5. Label reads ("read this label") bypass reasoning: one frame, verbatim
   transcription chips, spoken in Voice mode.

### 5. Guidance, iFixit, Reporting

* Repair card (`HudCard` mobile bottom-dock / `Sidebar` desktop panel):
  step n-of-m, specs (always "verify against the manual"), tools, warnings
  slot (always renders), manual title, sources, iFixit guides. "Scan Another
  Part" resets. Trust posture D2: **no numeric confidence anywhere, never
  invent specs**.
* One-tap HTML report export (steps + checkpoint photos, specs, warnings,
  sources, session log) with Web Share fallback to download.
* In-app log (`LogPanel`) with copy/download; offline banner; QR share with
  tunnel-URL override for opening the app on a phone.

## UI/UX (Industrial, Ultra-Simple)

* Single-screen viewfinder; header holds brand, overflow menu (⋯), and the
  badge row (LIVE/NO FEED, facing, tracking, status, contextual hint pill).
* Overflow menu: Voice mode, flashlight, QR, logs, freeze frame, switch
  camera, Clear AR View, Export Report.
* Bottom dock stacks error toast, guidance card, and the thumb-reachable
  query input; keyboard resizes (never pushes) the canvas.
* Mobile-first (Samsung/Chrome via HTTPS tunnel; localhost on desktop);
  respect safe areas; 48px minimum touch targets.

## Security & Privacy

* **Never hardcode API keys.** `import.meta.env.VITE_META_MODEL_API_KEY` only;
  acknowledge client-side exposure in docs; never log keys (redact in tests).
* Request camera/mic explicitly; surface denials and secure-context blocks
  as plain-text errors with fixes.
* `.env*` and `context/` stay gitignored; never commit them.

## Quality Gates (Definition of Done)

* `npm test` — full suite green; new behavior ships with co-located tests
  (`*.test.*` next to source); never weaken existing assertions to fit a
  change. Coverage aim: >80%.
* `npx tsc -b` clean; `npx eslint . --quiet` with **zero warnings**
  (component files export components only — helpers live in
  `services/`/`hooks/`).
* `npm run build` succeeds; verify the Pages `base` path still serves.
* No hardcoded secrets; permission flows handled; voice loop bounded;
  deploy workflow present with secret check + smoke test.

## File Conventions

* Components: `src/components/*.tsx` (+ `*.test.tsx`).
* Hooks: `src/hooks/*.ts`. Services: `src/services/*.ts` (+ `*.test.ts`).
* Types: `src/types.ts`. Fixtures: `src/test/`.
* Config at repo root: `vite.config.ts`, `tailwind.config.js`, `tsconfig*.json`.
* `Scanner.tsx` is the known god component (~1500 lines and shrinking via
  extraction to `services/`/`hooks/`); new shared helpers must not live in
  component files.
