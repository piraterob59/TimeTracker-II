// Local storage layer, built on IndexedDB — the browser's built-in
// database for storing structured data offline. Everything here wraps
// IndexedDB's old-school, callback/event-based API in Promises so the
// rest of the app can just `await store.getAllProjects()` etc.

const DB_NAME = 'timetracker';
const DB_VERSION = 3; // bump this + add an onupgradeneeded branch if the schema ever changes (2: categories, 3: points)

// Opens (or creates) the database and returns a Promise of the connection.
// `onupgradeneeded` only fires the very first time a browser opens this
// DB_NAME/DB_VERSION combo (or when DB_VERSION is bumped) — that's where
// the object stores ("tables") and their indexes get created.
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        // keyPath: 'id' means each stored project object's own `.id` field
        // is used as its database key (no separate auto-increment id).
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        // Indexes let us query entries by a field other than the primary
        // key — e.g. "all entries for project X" — without scanning every row.
        store.createIndex('projectId', 'projectId');
        store.createIndex('start', 'start');
      }
      // Added in version 2: categories (name + shared left color) that
      // projects belong to via `categoryId`.
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      // Added in version 3: daily scores for points projects, one row per
      // project per day, id `${projectId}_${YYYY-MM-DD}`.
      if (!db.objectStoreNames.contains('points')) {
        db.createObjectStore('points', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Shorthand for starting a transaction against one or more object stores.
// mode is 'readonly' or 'readwrite'.
function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

// Wraps a single IndexedDB request (e.g. `store.get(id)`) in a Promise,
// since IDBRequest objects use onsuccess/onerror callbacks natively.
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Wraps a whole transaction in a Promise, resolving with `result` once the
// transaction durably commits (see the note on putProject below for why
// that's different from — and safer than — waiting on the individual
// request). Used by every write method to avoid repeating this plumbing.
function txDone(t, result) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

// Generates a random unique id for new projects/entries (e.g.
// "3fa85f64-5717-4562-b3fc-2c963f66afa6").
export function uuid() {
  return crypto.randomUUID();
}

// Thin, promise-based wrapper around the app's IndexedDB access. Holds a
// single lazily-opened connection (`_db`) and exposes CRUD methods per
// object store. Call sites just `await store.putEntry(...)` etc. — none
// of the underlying transaction/event plumbing leaks out.
class Store {
  constructor() {
    this._db = null;
  }

  // Opens the DB connection once and reuses it for the lifetime of the page.
  async db() {
    if (!this._db) this._db = await openDB();
    return this._db;
  }

  async getAllProjects() {
    const db = await this.db();
    const t = tx(db, 'projects', 'readonly');
    return reqToPromise(t.objectStore('projects').getAll());
  }

  // put() both inserts new rows and overwrites existing ones with the same
  // key — there's no separate insert/update method in IndexedDB. Note the
  // individual put() request resolves before the data is durably
  // committed — waiting on the transaction (via txDone) instead is the
  // safe way to know the write has actually landed.
  async putProject(project) {
    const db = await this.db();
    const t = tx(db, 'projects', 'readwrite');
    t.objectStore('projects').put(project);
    return txDone(t, project);
  }

  // Deletes a project and cascades the delete to every entry and points
  // row that belongs to it, using their 'projectId' indexes to find them.
  async deleteProject(id) {
    const db = await this.db();
    const t = tx(db, ['projects', 'entries', 'points'], 'readwrite');
    t.objectStore('projects').delete(id);
    const range = IDBKeyRange.only(id);
    for (const name of ['entries', 'points']) {
      // A cursor walks matching rows one at a time (rather than loading them
      // all into memory first) — call .continue() after each delete to
      // advance to the next matching row until the cursor runs out.
      t.objectStore(name).index('projectId').openCursor(range).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }
    return txDone(t);
  }

  async getAllCategories() {
    const db = await this.db();
    const t = tx(db, 'categories', 'readonly');
    return reqToPromise(t.objectStore('categories').getAll());
  }

  async putCategory(category) {
    const db = await this.db();
    const t = tx(db, 'categories', 'readwrite');
    t.objectStore('categories').put(category);
    return txDone(t, category);
  }

  // Only ever called for empty categories, so nothing cascades.
  async deleteCategory(id) {
    const db = await this.db();
    const t = tx(db, 'categories', 'readwrite');
    t.objectStore('categories').delete(id);
    return txDone(t);
  }

  async getAllPoints() {
    const db = await this.db();
    const t = tx(db, 'points', 'readonly');
    return reqToPromise(t.objectStore('points').getAll());
  }

  async putPoints(row) {
    const db = await this.db();
    const t = tx(db, 'points', 'readwrite');
    t.objectStore('points').put(row);
    return txDone(t, row);
  }

  async deletePoints(id) {
    const db = await this.db();
    const t = tx(db, 'points', 'readwrite');
    t.objectStore('points').delete(id);
    return txDone(t);
  }

  async getAllEntries() {
    const db = await this.db();
    const t = tx(db, 'entries', 'readonly');
    return reqToPromise(t.objectStore('entries').getAll());
  }

  async putEntry(entry) {
    const db = await this.db();
    const t = tx(db, 'entries', 'readwrite');
    t.objectStore('entries').put(entry);
    return txDone(t, entry);
  }

  async deleteEntry(id) {
    const db = await this.db();
    const t = tx(db, 'entries', 'readwrite');
    t.objectStore('entries').delete(id);
    return txDone(t);
  }
}

// A single shared instance — every module that needs storage imports this
// same `store`, so they all share one lazily-opened DB connection.
export const store = new Store();
