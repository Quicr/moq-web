/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Vibrant accent palette
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        accent: {
          purple: '#a855f7',
          pink: '#ec4899',
          cyan: '#22d3ee',
          emerald: '#10b981',
        },
        // Glass colors
        glass: {
          white: 'rgba(255, 255, 255, 0.08)',
          light: 'rgba(255, 255, 255, 0.12)',
          border: 'rgba(255, 255, 255, 0.15)',
          highlight: 'rgba(255, 255, 255, 0.25)',
        },
        // Dark backgrounds
        surface: {
          900: '#0a0a0f',
          800: '#12121a',
          700: '#1a1a24',
          600: '#22222e',
        },
      },
      backgroundImage: {
        // Mesh gradient backgrounds
        'gradient-mesh': 'radial-gradient(at 40% 20%, rgba(120, 40, 200, 0.3) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(0, 150, 255, 0.25) 0px, transparent 50%), radial-gradient(at 0% 50%, rgba(255, 0, 128, 0.15) 0px, transparent 50%), radial-gradient(at 80% 50%, rgba(0, 200, 200, 0.2) 0px, transparent 50%), radial-gradient(at 0% 100%, rgba(100, 50, 255, 0.25) 0px, transparent 50%)',
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-glow': 'linear-gradient(135deg, rgba(168, 85, 247, 0.4) 0%, rgba(59, 130, 246, 0.4) 50%, rgba(34, 211, 238, 0.4) 100%)',
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
        'glass-lg': '0 25px 50px -12px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
        'glow-sm': '0 0 15px rgba(168, 85, 247, 0.3)',
        'glow': '0 0 30px rgba(168, 85, 247, 0.4)',
        'glow-cyan': '0 0 30px rgba(34, 211, 238, 0.4)',
        'glow-pink': '0 0 30px rgba(236, 72, 153, 0.4)',
        'inner-glow': 'inset 0 0 20px rgba(168, 85, 247, 0.15)',
      },
      animation: {
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'float': 'float 6s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': { opacity: '1', filter: 'brightness(1)' },
          '50%': { opacity: '0.8', filter: 'brightness(1.2)' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
