(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KEYS = Object.freeze({
    cards: "kg_web_cards",
    pending: "kg_web_pending",
    settings: "kg_web_settings",
    apiKey: "kg_web_api_key",
    totalDraws: "kg_web_total_draws",
    reviewDay: "kg_web_review_day",
    profileId: "kg_web_profile_id",
    migration: "kg_web_migration_v1",
    syncDirty: "kg_web_sync_dirty",
    qualityEvaluation: "kg_card_quality_eval_v1"
  });

  const CLEARABLE_KEYS = Object.freeze([
    KEYS.cards,
    KEYS.pending,
    KEYS.settings,
    KEYS.apiKey,
    KEYS.totalDraws,
    KEYS.reviewDay,
    KEYS.syncDirty,
    KEYS.qualityEvaluation
  ]);

  function createStorageAdapter(persistentStorage, sessionStorage, options) {
    const settings = options || {};
    const sanitizeCard = typeof settings.sanitizeCard === "function" ? settings.sanitizeCard : function (card) { return card; };
    const normalizeText = typeof settings.normalizeText === "function" ? settings.normalizeText : function (value) { return String(value || "").replace(/\s+/g, " ").trim(); };
    const defaultBaseUrl = settings.defaultBaseUrl || "https://uni-api.cstcloud.cn/v1";
    const defaultModel = settings.defaultModel || "qwen3.5";
    const dailyReviewLimit = positiveInteger(settings.dailyReviewLimit, 3);
    const createProfileId = typeof settings.createProfileId === "function" ? settings.createProfileId : defaultProfileId;

    function safeGet(storage, key) {
      try {
        return storage && storage.getItem(key);
      } catch (error) {
        return null;
      }
    }

    function safeSet(storage, key, value) {
      try {
        if (!storage) return false;
        storage.setItem(key, value);
        return true;
      } catch (error) {
        return false;
      }
    }

    function safeRemove(storage, key) {
      try {
        if (!storage) return false;
        storage.removeItem(key);
        return true;
      } catch (error) {
        return false;
      }
    }

    function readJson(key, fallback) {
      try {
        const raw = safeGet(persistentStorage, key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        return fallback;
      }
    }

    function writeJson(key, value) {
      return safeSet(persistentStorage, key, JSON.stringify(value));
    }

    function loadCardList(key) {
      const cards = readJson(key, []);
      return Array.isArray(cards) ? cards.map(sanitizeCard) : [];
    }

    function loadSettings() {
      const saved = readJson(KEYS.settings, {});
      const rawTemperature = Number(saved && saved.temperature);
      const temperature = Number.isFinite(rawTemperature) ? Math.max(0.2, Math.min(1.2, rawTemperature)) : 0.7;
      return {
        baseUrl: normalizeText((saved && saved.baseUrl) || defaultBaseUrl),
        model: normalizeText((saved && saved.model) || defaultModel),
        temperature: temperature,
        reducedMotion: saved && typeof saved.reducedMotion === "boolean" ? saved.reducedMotion : null
      };
    }

    function localDayKey(timestamp) {
      const date = new Date(timestamp === undefined ? Date.now() : timestamp);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    function loadReviewDay(timestamp) {
      const today = localDayKey(timestamp);
      const saved = readJson(KEYS.reviewDay, {});
      if (!saved || saved.day !== today) return { day: today, answered: 0, completed: false };
      const storedAnswered = Number(saved.answered || 0);
      const answered = Number.isFinite(storedAnswered) ? Math.max(0, Math.floor(storedAnswered)) : 0;
      return { day: today, answered: answered, completed: Boolean(saved.completed), continueAfterGoal: saved.continueAfterGoal === true,
        lastLearningUnitId: saved.lastLearningUnitId || null };
    }

    function loadApiKey() {
      return normalizeText(safeGet(sessionStorage, KEYS.apiKey) || safeGet(persistentStorage, KEYS.apiKey));
    }

    function saveApiKey(value, remember) {
      const apiKey = String(value || "").trim();
      if (!apiKey) return clearApiKey();
      if (remember) {
        safeRemove(sessionStorage, KEYS.apiKey);
        return safeSet(persistentStorage, KEYS.apiKey, apiKey);
      }
      safeRemove(persistentStorage, KEYS.apiKey);
      return safeSet(sessionStorage, KEYS.apiKey, apiKey);
    }

    function clearApiKey() {
      const persistent = safeRemove(persistentStorage, KEYS.apiKey);
      const session = safeRemove(sessionStorage, KEYS.apiKey);
      return persistent || session;
    }

    function clearAll() {
      CLEARABLE_KEYS.forEach(function (key) {
        safeRemove(persistentStorage, key);
      });
      clearApiKey();
    }

    function getOrCreateProfileId() {
      const existing = normalizeText(safeGet(persistentStorage, KEYS.profileId));
      if (/^profile_[A-Za-z0-9_-]{4,72}$/.test(existing)) return existing;
      const generated = normalizeText(createProfileId()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      const profileId = `profile_${generated || `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`}`;
      safeSet(persistentStorage, KEYS.profileId, profileId);
      return profileId;
    }

    function loadLearningStateSnapshot(timestamp) {
      const cards = uniqueCards(loadCardList(KEYS.cards));
      const savedIds = new Set(cards.map(function (card) { return card.id; }));
      const pending = uniqueCards(loadCardList(KEYS.pending)).filter(function (card) { return !savedIds.has(card.id); });
      const totalDraws = Number(safeGet(persistentStorage, KEYS.totalDraws) || 0);
      return {
        cards: cards,
        pending: pending,
        totalDraws: Number.isFinite(totalDraws) ? Math.max(0, Math.floor(totalDraws)) : 0,
        reviewDay: loadReviewDay(timestamp)
      };
    }

    function saveLearningStateSnapshot(state) {
      const value = state || {};
      const results = [
        writeJson(KEYS.cards, Array.isArray(value.cards) ? value.cards : []),
        writeJson(KEYS.pending, Array.isArray(value.pending) ? value.pending : []),
        safeSet(persistentStorage, KEYS.totalDraws, String(Math.max(0, Math.floor(Number(value.totalDraws) || 0)))),
        writeJson(KEYS.reviewDay, value.reviewDay || {})
      ];
      return results.every(Boolean);
    }

    return {
      clearAll: clearAll,
      clearApiKey: clearApiKey,
      getOrCreateProfileId: getOrCreateProfileId,
      hasPersistentApiKey: function () { return Boolean(normalizeText(safeGet(persistentStorage, KEYS.apiKey))); },
      isMigrationComplete: function () { return safeGet(persistentStorage, KEYS.migration) === "complete"; },
      isSyncDirty: function () { return safeGet(persistentStorage, KEYS.syncDirty) === "1"; },
      loadCards: function () { return loadCardList(KEYS.cards); },
      loadLearningStateSnapshot: loadLearningStateSnapshot,
      loadApiKey: loadApiKey,
      loadPending: function () { return loadCardList(KEYS.pending); },
      loadReviewDay: loadReviewDay,
      loadSettings: loadSettings,
      loadTotalDraws: function () {
        const value = Number(safeGet(persistentStorage, KEYS.totalDraws) || 0);
        return Number.isFinite(value) && value >= 0 ? value : 0;
      },
      localDayKey: localDayKey,
      markMigrationComplete: function () { return safeSet(persistentStorage, KEYS.migration, "complete"); },
      markSyncClean: function () { return safeRemove(persistentStorage, KEYS.syncDirty); },
      markSyncDirty: function () { return safeSet(persistentStorage, KEYS.syncDirty, "1"); },
      saveCards: function (cards) { return writeJson(KEYS.cards, Array.isArray(cards) ? cards : []); },
      saveLearningStateSnapshot: saveLearningStateSnapshot,
      saveApiKey: saveApiKey,
      savePending: function (cards) { return writeJson(KEYS.pending, Array.isArray(cards) ? cards : []); },
      saveReviewDay: function (reviewDay) { return writeJson(KEYS.reviewDay, reviewDay || {}); },
      saveSettings: function (value) { return writeJson(KEYS.settings, value || {}); },
      saveTotalDraws: function (value) { return safeSet(persistentStorage, KEYS.totalDraws, String(Math.max(0, Number(value) || 0))); }
    };
  }

  function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  function uniqueCards(cards) {
    const seen = new Set();
    return cards.filter(function (card) {
      if (!card || !card.id || seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
  }

  function defaultProfileId() {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
    return `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  }

  return { CLEARABLE_KEYS: CLEARABLE_KEYS, KEYS: KEYS, createStorageAdapter: createStorageAdapter };
});
