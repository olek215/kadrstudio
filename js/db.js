// Przechowywanie projektów i plików w IndexedDB (zostaje na tym komputerze).
let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('kadrstudio', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('media')) {
          const m = d.createObjectStore('media', { keyPath: 'id' });
          m.createIndex('project', 'projectId');
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transakcja przerwana'));
  });
}

export const db = {
  put: (store, v) => tx(store, 'readwrite', (s) => s.put(v)),
  get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
  del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  mediaOf: (pid) => tx('media', 'readonly', (s) => s.index('project').getAll(pid)),
  async deleteProject(pid) {
    const media = await db.mediaOf(pid);
    for (const m of media) await db.del('media', m.id);
    await db.del('projects', pid);
  },
};

// Poproś przeglądarkę, żeby nie kasowała danych przy braku miejsca.
export async function persistStorage() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* nic */ }
}
