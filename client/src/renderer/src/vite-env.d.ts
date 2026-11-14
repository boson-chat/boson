/// <reference types="vite/client" />

interface ImportMetaEnv {
  // The boson auth service; default https://auth.boson.chat.
  readonly VITE_AUTH_URL?: string;
  readonly VITE_BOSON_API_URL?: string;
  // The default network directory; default https://directory.boson.chat.
  readonly VITE_DIRECTORY_URL?: string;
  readonly VITE_ENGINE_URL?: string;
  readonly VITE_ENGINE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
