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
  server: { port: 5182, host: true },
});
