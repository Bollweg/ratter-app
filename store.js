// store.js: IndexedDB-Ablage auf dem Handy (Setups, Messungen, Maschinen, Einstellungen).
const NAME = "ratter", VERSION = 1;
let dbp;

function open() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ["setups", "messungen", "maschinen"]) d.createObjectStore(s, { keyPath: "id" });
      d.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result);
    t.onerror = () => rej(t.error);
  });
}

export const all = s => tx(s, "readonly", o => o.getAll());
export const put = (s, v) => tx(s, "readwrite", o => o.put(v));
export const del = (s, id) => tx(s, "readwrite", o => o.delete(id));
export const clear = s => tx(s, "readwrite", o => o.clear());
export const kvGet = k => tx("kv", "readonly", o => o.get(k));
export const kvSet = (k, v) => tx("kv", "readwrite", o => o.put(v, k));

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
