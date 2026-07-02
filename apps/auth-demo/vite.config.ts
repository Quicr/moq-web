import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    port: 5175,
    host: true,
  },
  define: {
    __MOQT_VERSION__: JSON.stringify('draft-16'),
  },
  build: {
    target: 'esnext',
  },
});
