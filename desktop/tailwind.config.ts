import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
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
        display: ['Songti SC', 'STSong', 'Noto Serif CJK SC', 'Georgia', 'serif'],
        body: ['LXGW WenKai', 'Kaiti SC', 'STKaiti', 'Georgia', 'serif'],
        mono: ['SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        imperial: '0 24px 70px rgb(77 39 22 / 0.16)',
        insetPaper: 'inset 0 0 0 1px rgb(var(--line) / 0.7)',
      },
      backgroundImage: {
        'paper-grain': 'radial-gradient(circle at 18% 12%, rgb(183 124 52 / 0.14), transparent 28%), radial-gradient(circle at 76% 4%, rgb(126 92 46 / 0.12), transparent 24%), linear-gradient(135deg, rgb(var(--paper)) 0%, rgb(var(--paper-2)) 100%)',
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
