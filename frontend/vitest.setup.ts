import { createRequire } from "node:module"

/** Give the jsdom tests jsdom's own Web Storage.
 *
 * Node >= 22 defines `localStorage` and `sessionStorage` as its own globals.
 * Vitest's jsdom environment leaves a global that Node already owns alone, so
 * jsdom's Storage is never installed and Node's is used instead: its
 * `localStorage` is inert unless the process was started with a
 * `--localstorage-file` path, so suites that touch storage fail in their
 * `beforeEach` on a missing `clear`, and its `sessionStorage` works but is not
 * the type jsdom's `StorageEvent` accepts as a `storageArea`.
 *
 * jsdom's Window keeps the Storage objects it built on `_localStorage` and
 * `_sessionStorage`, and the environment does copy those across; put them back
 * under their own names. They belong to the window the tests run in, so a
 * `StorageEvent` -- how a test imitates another browser tab -- accepts them as
 * a `storageArea`. Should a future jsdom stop exposing them, fall back to a
 * throwaway window of our own: one window serves one test file, so nothing a
 * test writes outlives it. jsdom is required rather than imported because it
 * ships no type declarations.
 */
if (typeof globalThis.localStorage?.clear !== "function") {
  const environment = globalThis as unknown as Record<"_localStorage" | "_sessionStorage", Storage | undefined>
  const borrowed: Partial<Record<"localStorage" | "sessionStorage", Storage | undefined>> =
    typeof environment._localStorage?.clear === "function"
      ? { localStorage: environment._localStorage, sessionStorage: environment._sessionStorage }
      : new (createRequire(import.meta.url)("jsdom").JSDOM)("", { url: "http://localhost:3000/" }).window
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const storage = borrowed[name]
    if (typeof storage?.clear === "function") {
      Object.defineProperty(globalThis, name, {
        value: storage, configurable: true, writable: true, enumerable: false,
      })
    }
  }
}
