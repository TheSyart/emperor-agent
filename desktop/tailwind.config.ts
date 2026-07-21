import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        /* semantic Codex tokens */
        bg: 'rgb(var(--bg) / <alpha-value>)',
        'bg-elevated': 'rgb(var(--bg-elevated) / <alpha-value>)',
        'bg-inset': 'rgb(var(--bg-inset) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        'fg-muted': 'rgb(var(--fg-muted) / <alpha-value>)',
        'fg-subtle': 'rgb(var(--fg-subtle) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-fg': 'rgb(var(--accent-fg) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        ok: 'rgb(var(--ok) / <alpha-value>)',
        /* categorical tones (capability tags / data-tone) */
        'tone-cyan': 'rgb(var(--tone-cyan) / <alpha-value>)',
        'tone-violet': 'rgb(var(--tone-violet) / <alpha-value>)',
        'tone-blue': 'rgb(var(--tone-blue) / <alpha-value>)',
        /* legacy aliases (deprecated; removed after consumers migrate) */
        paper: 'rgb(var(--paper) / <alpha-value>)',
        paper2: 'rgb(var(--paper-2) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        seal: 'rgb(var(--seal) / <alpha-value>)',
        jade: 'rgb(var(--jade) / <alpha-value>)',
        amber: 'rgb(var(--amber) / <alpha-value>)',
      },
      fontFamily: {
        display: [
          '-apple-system',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        body: [
          '-apple-system',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-md)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        imperial: '0 8px 28px rgb(var(--shadow-color) / 0.28)',
        insetPaper: 'inset 0 0 0 1px rgb(var(--border) / 0.7)',
      },
      backgroundImage: {
        'paper-grain':
          'linear-gradient(180deg, rgb(var(--bg)) 0%, rgb(var(--bg-inset)) 100%)',
      },
      animation: {
        'rise-in': 'rise-in 520ms ease both',
        'pulse-seal': 'pulse-seal 1.8s ease-in-out infinite',
      },
      keyframes: {
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-seal': {
          '0%, 100%': { opacity: '0.42', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.18)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config
