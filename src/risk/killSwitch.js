// Kill switch. State lives in a small store so a halt survives a process restart.
// Stores: memoryStore here, a JSON file store in src/node/fileStores.js, localStorage in the app.


export function memoryStore(initial = null) {
  let value = initial;
  return { read: () => value, write: v => { value = v; } };
}


export function createKillSwitch(store = memoryStore(), now = () => new Date()) {
  return {
    // Fails closed: if the stored state can't be read as "not halted", treat as halted.
    isHalted() {
      const s = store.read();
      if (s == null) return false;
      return s.halted !== false;
    },
    status() {
      return store.read() || { halted: false };
    },
    halt(reason, by = 'user') {
      store.write({ halted: true, reason, by, at: now().toISOString() });
    },
    resume(by = 'user') {
      store.write({ halted: false, by, at: now().toISOString() });
    }
  };
}
