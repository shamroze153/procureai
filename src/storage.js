// Standalone-deployment storage shim.
//
// The app was originally written against a host-provided `window.storage`
// API (get/set/delete/list) available inside the Claude artifact runtime.
// Outside that runtime there is no such host API, so this file provides
// the exact same shape backed by the browser's own localStorage — every
// existing `window.storage.get(...)` / `.set(...)` call in App.jsx works
// unchanged. This is per-browser, client-side only storage: it does not
// sync across devices and is cleared if the user clears site data. That's
// an intentional, honest trade-off for a Phase-1 prototype with no
// backend database (a real multi-user backend is explicitly out of scope
// for this release).

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return raw; }
}

export const storage = {
  async get(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      return { key, value: raw };
    } catch (e) {
      console.error("storage.get failed", e);
      return null;
    }
  },

  async set(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return { key, value };
    } catch (e) {
      console.error("storage.set failed", e);
      return null;
    }
  },

  async delete(key) {
    try {
      window.localStorage.removeItem(key);
      return { key, deleted: true };
    } catch (e) {
      console.error("storage.delete failed", e);
      return null;
    }
  },

  async list(prefix) {
    try {
      const keys = Object.keys(window.localStorage).filter((k) => !prefix || k.startsWith(prefix));
      return { keys, prefix };
    } catch (e) {
      console.error("storage.list failed", e);
      return null;
    }
  },
};
