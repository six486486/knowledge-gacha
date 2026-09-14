(function (root, factory) {
  const schema = typeof module === "object" && module.exports ? require("../../../shared/knowledge-schema.js") : root.KnowledgeGachaKnowledgeSchema;
  const api = factory(schema);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaExtensionStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (schema) {
  "use strict";

  const DB_KEY = "kg_extension_harness_v1";

  function normalizeDb(value, localDay, timestamp) {
    const db = value && typeof value === "object" ? value : {};
    return schema.upgradeDb(Object.assign({
      schemaVersion: schema.SCHEMA_VERSION,
      version: 0,
      learningState: { cards: [], pending: [], totalDraws: 0, reviewDay: { day: localDay(timestamp), answered: 0, completed: false } },
      migrations: [],
      drafts: [],
      sourceChecks: [],
      documents: [],
      discoveryPools: [],
      reviewEvents: [],
      recentLearningEvents: [],
      memoryMutations: [],
      memoryVersion: 1,
      preferences: [],
      candidates: [],
      runs: [],
      traces: {},
      pendingRuns: {},
      companionSchemaVersion: 1,
      companionSessions: [],
      audit: []
    }, db));
  }

  function createHarnessStore(options) {
    const settings = options || {};
    const storage = settings.storage;
    const utils = settings.utils;
    const now = settings.now || Date.now;
    const databaseKey = DB_KEY + ":" + String(settings.profileId || "default");
    const repository = settings.repository;
    const largeFields = { documents: ["content", "blocks", "selections"], materials: ["text", "image", "blocks", "source"], drafts: ["material", "context", "sourceCheck", "evidence", "source"], companionSessions: ["context", "messages", "turn", "contextSummary"] };
    let snapshot;
    let persisted;
    let expectedState;
    let pending = Promise.resolve();
    let failure = null;
    let active = 0;
    let refreshing = Promise.resolve();
    const operations = new Set();
    let exclusiveWork = Promise.resolve();
    const payloadCache = new Map();
    let backupReferences;
    function legacyReferences() {
      if (!backupReferences) {
        try { backupReferences = new Set(references(JSON.parse(storage.getItem(databaseKey) || "{}"))); }
        catch (_) { backupReferences = new Set(); }
      }
      return backupReferences;
    }

    function references(db) {
      return Object.keys(largeFields).flatMap(function (table) { return (db[table] || []).map(function (row) { return row.payloadId; }).filter(Boolean); });
    }
    async function hydrate(value) {
      const db = normalizeDb(value, utils.localDay, now());
      for (const table of Object.keys(largeFields)) for (const row of db[table] || []) {
        if (!row.payloadId) continue;
        let payload = payloadCache.get(row.payloadId);
        if (!payload) {
          payload = await repository.get("payloads", row.payloadId);
          if (!payload) throw new Error("材料记录缺失，已保留原有索引；请从备份恢复，不要清空数据");
          payloadCache.set(row.payloadId, payload);
        }
        Object.assign(row, utils.clone(payload));
      }
      return db;
    }
    async function reload() {
      const read = async function () {
        const canonical = await repository.get("state", "current");
        expectedState = JSON.stringify(canonical || {});
        const serialized = canonical ? JSON.stringify(canonical) : storage.getItem(databaseKey) || "{}";
        const current = await hydrate(JSON.parse(serialized));
        persisted = serialized;
        snapshot = current;
      };
      // Keep referenced payloads alive until this index has been fully read.
      if (globalThis.navigator?.locks) await navigator.locks.request(databaseKey + ":commit", { mode: "shared" }, read);
      else await read();
    }
    async function persist(db) {
      const projected = utils.clone(db);
      const previous = JSON.parse(persisted);
      const rows = [];
      for (const table of Object.keys(largeFields)) for (const row of projected[table] || []) {
        const payload = {};
        largeFields[table].forEach(function (field) { if (Object.hasOwn(row, field)) { payload[field] = row[field]; delete row[field]; } });
        if (!Object.keys(payload).length) { delete row.payloadId; continue; }
        const prior = (previous[table] || []).find(function (item) { return item.id === row.id; });
        if (prior?.payloadId && JSON.stringify(payloadCache.get(prior.payloadId)) === JSON.stringify(payload)) row.payloadId = prior.payloadId;
        if (!row.payloadId || JSON.stringify(payloadCache.get(row.payloadId)) !== JSON.stringify(payload)) {
          row.payloadId = utils.id("payload");
          rows.push({ id: row.payloadId, value: payload });
        }
      }
      projected.materialStorage = "indexeddb-v1";
      projected.stateStorage = "indexeddb-v2";
      const commit = async function () {
        const prior = JSON.parse(persisted);
        const serialized = JSON.stringify(projected);
        await repository.commitState(expectedState, projected, rows);
        expectedState = serialized;
        persisted = serialized;
        rows.forEach(function (row) { payloadCache.set(row.id, row.value); });
        const used = new Set(references(projected));
        const backup = legacyReferences();
        const stale = references(prior).filter(function (id) { return !used.has(id) && !backup.has(id); });
        // Reclamation is separate from the commit: failing to reclaim cannot undo a saved card.
        try { await repository.removeMany("payloads", stale); stale.forEach(function (id) { payloadCache.delete(id); }); } catch (_) { /* Reclaimed during next startup. */ }
      };
      if (globalThis.navigator?.locks) await navigator.locks.request(databaseKey + ":commit", commit);
      else await commit();
      return projected;
    }
    const initialize = async function () {
      await reload();
      if (snapshot.stateStorage !== "indexeddb-v2") {
        await persist(snapshot);
        await reload();
      }
      const sweep = async function () {
        const live = new Set(references(await repository.get("state", "current") || {}));
        // Legacy data stays recoverable until explicit clear; its referenced payloads stay alive too.
        legacyReferences().forEach(function (id) { live.add(id); });
        await repository.removeMany("payloads", (await repository.list("payloads")).filter(function (row) { return !live.has(row.id); }).map(function (row) { return row.id; }));
      };
      if (globalThis.navigator?.locks) await navigator.locks.request(databaseKey + ":commit", sweep);
      else await sweep();
    };
    // Only one page may migrate the legacy index and reclaim its old payloads.
    const ready = !repository ? Promise.resolve() : globalThis.navigator?.locks
      ? navigator.locks.request(databaseKey + ":initialize", initialize) : initialize();
    // Initialization errors are returned by API calls, never converted into an empty database.
    ready.catch(function () {});

    function readDb() {
      if (repository) {
        if (!snapshot) throw new Error("材料数据库尚未就绪");
        return normalizeDb(utils.clone(snapshot), utils.localDay, now());
      }
      try {
        return normalizeDb(JSON.parse(storage.getItem(databaseKey) || "{}"), utils.localDay, now());
      } catch (error) {
        return normalizeDb({}, utils.localDay, now());
      }
    }

    function writeDb(db) {
      if (repository) {
        snapshot = utils.clone(db);
        const revision = utils.clone(db);
        pending = pending.then(async function () {
          if (failure) return;
          try { await persist(revision); } catch (error) { failure = error; }
        });
        return db;
      }
      storage.setItem(databaseKey, JSON.stringify(db));
      return db;
    }

    function mutate(mutator) {
      const db = readDb();
      const result = mutator(db);
      writeDb(db);
      return result;
    }

    function clear() {
      writeDb(normalizeDb({}, utils.localDay, now()));
    }

    async function flush() {
      await ready;
      await pending;
      if (failure) {
        throw failure;
      }
    }
    async function execute(operation) {
      await ready;
      if (repository && !active) refreshing = (async function () { await pending; failure = null; await reload(); })();
      active += 1;
      try { await refreshing; const result = await operation(); await flush(); return result; }
      catch (error) { await flush(); throw error; }
      finally { active -= 1; }
    }

    function run(operation, exclusive) {
      const perform = function () { return execute(operation); };
      // Normal calls may overlap. Clearing waits for them and excludes new calls
      // until both the index and its material repository have been cleared.
      if (globalThis.navigator?.locks) return navigator.locks.request(databaseKey + ":operations", { mode: exclusive ? "exclusive" : "shared" }, perform);
      const prior = exclusive ? Promise.allSettled(Array.from(operations)) : exclusiveWork;
      const result = prior.then(perform);
      if (exclusive) exclusiveWork = result.catch(function () {});
      operations.add(result);
      result.then(function () { operations.delete(result); }, function () { operations.delete(result); });
      return result;
    }

    async function readPersisted() {
      if (!repository) return readDb();
      await ready;
      // The caller may already hold the commit Web Lock. One IDB read transaction
      // keeps state and payloads consistent without recursively acquiring that lock.
      return normalizeDb(await repository.readState() || {}, utils.localDay, now());
    }
    return { databaseKey: databaseKey, readDb: readDb, readPersisted: readPersisted, writeDb: writeDb, mutate: mutate, clear: clear, ready: ready, flush: flush, run: run };
  }

  return { DB_KEY: DB_KEY, createHarnessStore: createHarnessStore, normalizeDb: normalizeDb };
});
