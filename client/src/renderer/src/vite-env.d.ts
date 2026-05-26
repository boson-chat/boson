/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  // Legacy alias for VITE_SUPABASE_PUBLISHABLE_KEY — kept so the local-dev
  // path (`make client-env`, which reads ANON_KEY from supabase-cli)
  // continues to type-check.
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_BOSON_API_URL?: string;
  readonly VITE_ENGINE_URL?: string;
  readonly VITE_ENGINE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
