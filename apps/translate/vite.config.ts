import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' ? '/' : (process.env.BASE_URL ? `${process.env.BASE_URL}apps/translate/` : '/apps/translate/'),
}))
