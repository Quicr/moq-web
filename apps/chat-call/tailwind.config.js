/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        surface: {
          light: 'rgba(255, 255, 255, 0.72)',
          dark: 'rgba(15, 23, 42, 0.80)',
        },
      },
      backdropBlur: {
        glass: '16px',
      },
      boxShadow: {
        glass: '0 4px 24px rgba(15, 23, 42, 0.06)',
        'glass-hover': '0 8px 32px rgba(15, 23, 42, 0.1)',
      },
    },
  },
  plugins: [],
};
