/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        mocha: {
          50: '#fdf8f0',
          100: '#f5e6d3',
          200: '#e8cba5',
          300: '#d4a574',
          400: '#c68a4e',
          500: '#a0693a',
          600: '#8B4513',
          700: '#6B3410',
          800: '#4a2508',
          900: '#2d1605',
        },
        cream: {
          50: '#fffdf9',
          100: '#fef9f0',
          200: '#fdf3e4',
          300: '#faebd7',
        },
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(139, 69, 19, 0.08)',
        'glass-lg': '0 16px 48px rgba(139, 69, 19, 0.12)',
        'warm': '0 4px 16px rgba(198, 138, 78, 0.15)',
      },
    },
  },
  plugins: [],
};
