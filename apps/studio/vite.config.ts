import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const moqtVersion = process.env.MOQT_VERSION || 'draft-18';

export default defineConfig({
  plugins: [react(), basicSsl()],
  base: process.env.BASE_URL || '/',
  define: {
    __MOQT_VERSION__: JSON.stringify(moqtVersion),
    'import.meta.env.VITE_MOQT_VERSION': JSON.stringify(moqtVersion),
  },
  server: {
    port: 5180,
    host: true,
    proxy: {
      // Cloudflare's api.cloudflare.com doesn't return CORS headers, so the
      // Cloudflare auth adapter can't call it directly from the browser.
      // Proxy /cf-api/* → https://api.cloudflare.com/client/v4/* in dev.
      '/cf-api': {
        target: 'https://api.cloudflare.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cf-api/, '/client/v4'),
      },
    },
  },
});
