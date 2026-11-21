// Stan edytora + historia zmian (cofnij / ponów).
export class Store {
  constructor() {
    this.project = null;
    this.sel = null;
    this.time = 0;
    this.undoStack = [];
    this.redoStack = [];
    this._snap = '';
    this._l = new Map();
  }
  on(ev, fn) {
    if (!this._l.has(ev)) this._l.set(ev, new Set());
    this._l.get(ev).add(fn);
    return () => this._l.get(ev).delete(fn);
  }
  emit(ev, data) {
    const set = this._l.get(ev);
    if (!set) return;
    for (const f of set) { try { f(data); } catch (e) { console.error(e); } }
  }
  load(project) {
    this.project = project;
    this.sel = null;
    this.time = 0;
    this.undoStack = [];
    this.redoStack = [];
    this._snap = JSON.stringify(project);
    this.emit('load');
    this.emit('change');
    this.emit('select');
  }
  // zmiana "na żywo" (np. przeciąganie suwaka) – bez wpisu w historii
  changed() { this.emit('change'); }
  // zakończona zmiana – trafia do historii i zapisu
  commit() {
    if (!this.project) return;
    const s = JSON.stringify(this.project);
    if (s === this._snap) { this.emit('change'); return; }
    this.undoStack.push(this._snap);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this._snap = s;
    this.redoStack.length = 0;
    this.emit('change');
    this.emit('commit');
  }
  _restore(json) {
    this.project = JSON.parse(json);
    this._snap = json;
    if (this.sel && !this.clip(this.sel)) { this.sel = null; this.emit('select'); }
    this.emit('change');
    this.emit('commit');
    this.emit('history');
  }
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.project));
    this._restore(this.undoStack.pop());
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.project));
    this._restore(this.redoStack.pop());
    return true;
  }
  clip(id) { return id && this.project ? this.project.clips.find((c) => c.id === id) : null; }
  get selected() { return this.clip(this.sel); }
  select(id) {
    if (this.sel === id) return;
    this.sel = id || null;
    this.emit('select');
  }
  setTime(t) {
    this.time = t;
    this.emit('time', t);
  }
}
