// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import preact from "@preact/preset-vite";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].js"
        }
      }
    }
  },
  renderer: {
    plugins: [preact()]
  }
});
export {
  electron_vite_config_default as default
};
