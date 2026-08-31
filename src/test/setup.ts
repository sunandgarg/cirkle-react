import "@testing-library/jest-dom";

// Node 26 exposes an experimental global localStorage accessor that resolves
// to undefined unless a backing file is configured and shadows jsdom's value.
// Use an isolated standards-compatible store in tests across Node versions.
const testStorage = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() { return testStorage.size; },
  clear: () => testStorage.clear(),
  getItem: (key) => testStorage.get(String(key)) ?? null,
  key: (index) => [...testStorage.keys()][index] ?? null,
  removeItem: (key) => { testStorage.delete(String(key)); },
  setItem: (key, value) => { testStorage.set(String(key), String(value)); },
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testLocalStorage });
Object.defineProperty(window, "localStorage", { configurable: true, value: testLocalStorage });

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
