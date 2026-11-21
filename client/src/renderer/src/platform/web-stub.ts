// Stands in for platform/web in the desktop and phone builds (vite.config.ts
// aliases it), so they never bundle the web shell or its engine.wasm.
export async function installWebBridges(): Promise<void> {
  throw new Error('platform/web is only in the web build (VITE_BOSON_SHELL=web)');
}
