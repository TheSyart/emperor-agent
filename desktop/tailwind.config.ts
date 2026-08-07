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
        /* grok 式文本层级:fg 叠 text-* alpha(玻璃上透出环境色) */
        secondary: 'rgb(var(--fg) / var(--text-secondary))',
        tertiary: 'rgb(var(--fg) / var(--text-tertiary))',
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-fg': 'rgb(var(--accent-fg) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        ok: 'rgb(var(--ok) / <alpha-value>)',
        /* categorical tones (capability tags / data-tone) */
        'tone-cyan': 'rgb(var(--tone-cyan) / <alpha-value>)',
        'tone-violet': 'rgb(var(--tone-violet) / <alpha-value>)',
        'tone-blue': 'rgb(var(--tone-blue) / <alpha-value>)',
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
      zIndex: {
        base: 'var(--z-base)',
        raised: 'var(--z-raised)',
        sticky: 'var(--z-sticky)',
        overlay: 'var(--z-overlay)',
        drawer: 'var(--z-drawer)',
        popover: 'var(--z-popover)',
        toast: 'var(--z-toast)',
        modal: 'var(--z-modal)',
        menu: 'var(--z-menu)',
        lightbox: 'var(--z-lightbox)',
      },
      transitionDuration: {
        instant: 'var(--duration-instant)',
        fast: 'var(--duration-fast)',
        DEFAULT: 'var(--duration)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        apple: 'var(--ease-out)',
        spring: 'var(--ease-spring)',
        'apple-in': 'var(--ease-in)',
      },
      backgroundImage: {
        grain:
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
