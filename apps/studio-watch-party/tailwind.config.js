/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0b0e17',
          50: '#131826',
          100: '#1a2033',
          200: '#252c42',
        },
        accent: {
          DEFAULT: '#22d3ee',
          light: '#67e8f9',
          glow: '#a5f3fc',
        },
        chip: {
          active: '#10b981',
          idle: '#475569',
          warn: '#f59e0b',
          err: '#ef4444',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular'],
      },
    },
  },
  plugins: [],
};
