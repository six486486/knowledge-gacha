(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaMaterialRepository = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DATABASE = "kg_materials_v1";
  const STORES = ["payloads", "assets", "imports", "state", "vectors"];

  function createMaterialRepository(options) {
    const settings = options || {};
    const factory = settings.indexedDB || globalThis.indexedDB;
    const prefix = String(settings.profileId || "default") + ":";
    let connection;
    function open() {
      if (!factory) return Promise.reject(new Error("当前环境无法保存导入材料，请使用支持 IndexedDB 的浏览器"));
      if (!connection) connection = new Promise(function (resolve, reject) {
        const request = factory.open(DATABASE, 2);
        request.onupgradeneeded = function () { STORES.forEach(function (name) { if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); }); };
        request.onerror = function () { connection = null; reject(request.error); };
        request.onblocked = function () { reject(new Error("材料数据库等待其他窗口关闭，请关闭旧页面后重试")); };
        request.onsuccess = function () {
          const db = request.result;
          db.onversionchange = function () { db.close(); connection = null; };
          resolve(db);
        };
      });
      return connection;
    }
    async function transaction(name, mode, operation) {
      const db = await open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(name, mode);
        let value;
        tx.oncomplete = function () { resolve(value); };
        tx.onabort = tx.onerror = function () { reject(tx.error || new Error("材料保存失败，原有数据未改动")); };
        try { operation(tx.objectStore(name), function (result) { value = result; }); }
        catch (error) { tx.abort(); reject(error); }
      });
    }
    function get(name, id) {
      return transaction(name, "readonly", function (store, done) { const request = store.get(prefix + id); request.onsuccess = function () { done(request.result); }; });
    }
    function list(name) {
      return transaction(name, "readonly", function (store, done) {
        const rows = [];
        const cursor = store.openCursor();
        cursor.onsuccess = function () {
          const item = cursor.result;
          if (!item) { done(rows); return; }
          if (String(item.key).startsWith(prefix)) rows.push({ id: String(item.key).slice(prefix.length), value: item.value });
          item.continue();
        };
      });
    }
    function putMany(name, rows) { return transaction(name, "readwrite", function (store) { rows.forEach(function (row) { store.put(row.value, prefix + row.id); }); }); }
    function removeMany(name, ids) { return transaction(name, "readwrite", function (store) { ids.forEach(function (id) { store.delete(prefix + id); }); }); }
    async function commitState(expected, value, rows) {
      const db = await open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(["state", "payloads"], "readwrite");
        let failure;
        tx.oncomplete = resolve;
        tx.onabort = tx.onerror = function () { reject(failure || tx.error || new Error("数据库保存失败，旧记录已保留")); };
        const state = tx.objectStore("state");
        const request = state.get(prefix + "current");
        request.onsuccess = function () {
          if (JSON.stringify(request.result || {}) !== expected) {
            failure = new Error("材料已在其他窗口更新，请重新打开当前任务后重试"); tx.abort(); return;
          }
          try {
            rows.forEach(function (row) { tx.objectStore("payloads").put(row.value, prefix + row.id); });
            state.put(value, prefix + "current");
          } catch (error) { failure = error; tx.abort(); }
        };
      });
    }
    async function readState() {
      const db = await open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(["state", "payloads"], "readonly");
        let value, failure;
        tx.oncomplete = function () { resolve(value); };
        tx.onabort = tx.onerror = function () { reject(failure || tx.error); };
        const request = tx.objectStore("state").get(prefix + "current");
        request.onsuccess = function () {
          value = request.result;
          for (const table of ["documents", "materials", "drafts"]) for (const row of value?.[table] || []) {
            if (!row.payloadId) continue;
            const payload = tx.objectStore("payloads").get(prefix + row.payloadId);
            payload.onsuccess = function () {
              if (!payload.result) { failure = new Error("材料记录缺失，已保留原有索引；请从备份恢复，不要清空数据"); tx.abort(); return; }
              Object.assign(row, payload.result);
            };
          }
        };
      });
    }
    // Keep the empty canonical state as a tombstone so an old migration backup cannot resurrect data.
    async function clear() { for (const name of STORES.filter(function (name) { return name !== "state"; })) await removeMany(name, (await list(name)).map(function (row) { return row.id; })); }
    return { open: open, get: get, list: list, putMany: putMany, removeMany: removeMany, clear: clear,
      commitState: commitState,
      readState: readState,
      put: function (name, id, value) { return putMany(name, [{ id: id, value: value }]); },
      remove: function (name, id) { return removeMany(name, [id]); },
      close: async function () { if (connection) (await connection).close(); connection = null; } };
  }
  return { DATABASE: DATABASE, createMaterialRepository: createMaterialRepository };
});
