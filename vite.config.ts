import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev-tunnel hosts. Set VITE_ALLOWED_HOSTS to your exact tunnel hostname(s),
 * comma-separated (e.g. `VITE_ALLOWED_HOSTS=abc123.trycloudflare.com`), to
 * avoid the broad wildcard. The `.trycloudflare.com` fallback keeps
 * `npm run dev` working out of the box with `cloudflared tunnel`.
 */
const allowedHosts =
  (process.env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length > 0
    ? (process.env.VITE_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['.trycloudflare.com']

export default defineConfig({
  base: '/wrenchmind/',
  plugins: [react()],
  server: {
    allowedHosts,
  },
  preview: {
    // Same tunnel allowance for `vite preview` (host check also applies).
    allowedHosts,
  },
})
