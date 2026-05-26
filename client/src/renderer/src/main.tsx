import { render } from 'preact';
import { App, buildApp } from './app';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
const bosonUrl = import.meta.env.VITE_BOSON_API_URL ?? 'http://localhost:3000';

const root = document.getElementById('app')!;

if (!anonKey) {
  root.innerHTML =
    '<div style="padding:2rem;color:#fa5252;font-family:system-ui">' +
    'VITE_SUPABASE_ANON_KEY is not set. Run <code>make client-env</code>.' +
    '</div>';
} else {
  const props = buildApp({
    supabaseUrl,
    anonKey,
    bosonUrl,
    engineUrl: import.meta.env.VITE_ENGINE_URL,
    engineToken: import.meta.env.VITE_ENGINE_TOKEN,
  });
  // Fire init async — App renders immediately and shows "Loading…" until ready.
  props.auth.init().catch((err) => {
    console.error('auth.init failed', err);
    props.auth.markFatal(err instanceof Error ? err.message : String(err));
  });
  if (props.engine) {
    props.engine.open().catch((err) => console.error('engine.open failed', err));
  }
  render(<App {...props} />, root);
}
