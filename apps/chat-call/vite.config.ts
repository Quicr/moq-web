import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const moqtVersion = process.env.MOQT_VERSION || 'draft-16';

export default defineConfig({
  plugins: [react(), basicSsl()],
  base: process.env.BASE_URL || '/',
  define: {
    __MOQT_VERSION__: JSON.stringify(moqtVersion),
    'import.meta.env.VITE_MOQT_VERSION': JSON.stringify(moqtVersion),
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://snk-dev-1.m10x.org:3200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/v1'),
      },
    },
  },
});
