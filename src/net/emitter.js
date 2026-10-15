// Minimal synchronous event emitter (no Node dependency, works in the browser).
export class Emitter {
  constructor() { this._listeners = new Map(); }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => { off(); fn(...args); });
    return off;
  }

  emit(type, ...args) {
    const list = this._listeners.get(type);
    if (!list || list.length === 0) return false;
    for (const fn of list.slice()) {
      try { fn(...args); } catch (err) { console.error(`listener for '${type}' threw:`, err); }
    }
    return true;
  }

  removeAll() { this._listeners.clear(); }
}
