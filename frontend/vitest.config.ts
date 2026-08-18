import { configDefaults, defineConfig } from "vitest/config"
import path from "node:path"
import { fileURLToPath } from "node:url"

const configDirectory = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(configDirectory),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
})
