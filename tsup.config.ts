import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  treeshake: true,
  external: ["vscode"],
  format: ["cjs"],
  splitting: false,
  sourcemap: true,
  minify: false,
});