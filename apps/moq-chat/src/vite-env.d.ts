/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_TOKEN_SERVICE_URL: string;
  readonly VITE_RELAY_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
