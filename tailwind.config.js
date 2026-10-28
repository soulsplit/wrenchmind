/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        hud: {
          ink: '#04070a',
          panel: '#0a1014',
          scrim: 'rgba(4, 7, 10, 0.8)',
          line: 'rgba(255, 255, 255, 0.12)',
        },
        neon: {
          DEFAULT: '#00FFCC',
          dim: 'rgba(0, 255, 204, 0.35)',
        },
        // Overlay callout semantics (match Scanner.tsx STROKE/FILL):
        // component = cyan, connector = yellow, fastener = red.
        callout: {
          component: '#00FFFF',
          connector: '#FFFF00',
          fastener: '#FF0000',
        },
        warn: {
          DEFAULT: '#FBBF24',
          deep: '#B45309',
        },
        confirm: {
          DEFAULT: '#4ADE80',
          deep: '#15803D',
        },
        danger: {
          DEFAULT: '#F87171',
          deep: '#B91C1C',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Type ramp per context/gemini-code-1793183567220.txt.
      fontSize: {
        'hud-title': ['20px', { lineHeight: '28px', letterSpacing: '-0.025em', fontWeight: '700' }],
        'hud-body': ['14px', { lineHeight: '20px', fontWeight: '500' }],
        'hud-spec': ['12px', { lineHeight: '16px', fontWeight: '400' }],
        'hud-micro': ['10px', { lineHeight: '14px', letterSpacing: '0.05em', fontWeight: '600' }],
      },
      boxShadow: {
        'sam-glow': '0 0 12px rgba(0, 255, 204, 0.65), 0 0 32px rgba(0, 255, 204, 0.25)',
        'hud-card': '0 8px 32px rgba(0, 0, 0, 0.6)',
      },
    },
  },
  plugins: [],
}
