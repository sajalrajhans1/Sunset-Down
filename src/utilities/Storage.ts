/**
 * Thin, failure-tolerant localStorage wrapper. Private-browsing modes and
 * blocked third-party storage must never crash the game, so every call is
 * wrapped and silently degrades to in-memory only.
 */

const memoryFallback = new Map<string, string>();
let storageAvailable: boolean | null = null;

function isAvailable(): boolean {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const probe = '__sh_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  return storageAvailable;
}

export const Storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = isAvailable() ? window.localStorage.getItem(key) : (memoryFallback.get(key) ?? null);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw) as T;
      // Merge onto the fallback so newly added settings keys get defaults.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof fallback === 'object') {
        return { ...(fallback as object), ...(parsed as object) } as T;
      }
      return parsed;
    } catch {
      return fallback;
    }
  },

  set<T>(key: string, value: T): void {
    try {
      const raw = JSON.stringify(value);
      if (isAvailable()) window.localStorage.setItem(key, raw);
      else memoryFallback.set(key, raw);
    } catch {
      /* quota exceeded or serialisation failure — non-fatal */
    }
  },

  remove(key: string): void {
    try {
      if (isAvailable()) window.localStorage.removeItem(key);
      else memoryFallback.delete(key);
    } catch {
      /* non-fatal */
    }
  },
};

export const STORAGE_KEYS = {
  settings: 'sunset-hollow:settings:v1',
  records: 'sunset-hollow:records:v1',
} as const;
