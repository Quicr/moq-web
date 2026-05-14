import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_URL ? `${process.env.BASE_URL}apps/msf-compression-benchmark/` : '/apps/msf-compression-benchmark/',
})
