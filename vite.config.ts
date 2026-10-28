import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/wrenchmind/',
  plugins: [react()],
  server: {
    // Allow Cloudflare Tunnel URLs (random subdomains) for mobile testing.
    allowedHosts: ['.trycloudflare.com'],
  },
  preview: {
    // Same tunnel allowance for `vite preview` (host check also applies).
    allowedHosts: ['.trycloudflare.com'],
  },
})
