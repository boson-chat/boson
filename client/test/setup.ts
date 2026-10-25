import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/preact';
import { afterEach } from 'vitest';

// Node 25+ has its own Web Storage globals, which shadow the DOM
// environment's and are undefined unless node runs with --localstorage-file.
// Stand in an in-memory Storage so tests (and the code under test) get one.
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string): void { this.items.delete(key); }
  setItem(key: string, value: string): void { this.items.set(key, String(value)); }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (globalThis[name] === undefined) {
    Object.defineProperty(globalThis, name, { configurable: true, value: new MemoryStorage() });
  }
}

afterEach(() => {
  cleanup();
});
