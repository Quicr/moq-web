import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const moqtVersion = process.env.MOQT_VERSION || 'draft-16';

export default defineConfig({
  plugins: [basicSsl()],
  base: './',
  server: {
    port: 5175,
    host: true,
  },
  define: {
    __MOQT_VERSION__: JSON.stringify(moqtVersion),
  },
  build: {
    target: 'esnext',
  },
});
