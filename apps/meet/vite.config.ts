import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [react(), basicSsl()],
  base: './',
  server: {
    port: 5176,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  define: {
    __MOQT_VERSION__: JSON.stringify('draft-16'),
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
});
