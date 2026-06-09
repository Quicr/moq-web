import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: '/apps/mocha-chat/',
  plugins: [react(), basicSsl()],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://snk-dev-1.m10x.org:3200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/v1'),
      },
    },
  },
});
