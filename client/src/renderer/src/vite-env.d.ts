/// <reference types="vite/client" />

interface ImportMetaEnv {
  // The boson auth service; default https://auth.boson.chat.
  readonly VITE_AUTH_URL?: string;
  readonly VITE_BOSON_API_URL?: string;
  // The default network directory; default https://directory.boson.chat.
  readonly VITE_DIRECTORY_URL?: string;
  readonly VITE_ENGINE_URL?: string;
  readonly VITE_ENGINE_TOKEN?: string;
  // 'web' for the browser build (chat.boson.chat): platform/web.
  readonly VITE_BOSON_SHELL?: string;
  // The usage & health stats receiver (modules/telemetry); default
  // https://telemetry.boson.chat outside dev/e2e builds, "off" for none.
  readonly VITE_TELEMETRY_URL?: string;
}

// The web build's engine (scripts/build-web-engine.mjs → platform/web/gen,
// aliased in vite.config.ts).
declare module 'boson-engine-wasm?url' {
  const url: string;
  export default url;
}
declare module 'boson-wasm-exec';

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
