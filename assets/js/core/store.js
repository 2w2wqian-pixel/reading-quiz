/* ============================================================
   store.js — 本機儲存（IndexedDB 為主，localStorage 為輔）
   物件庫：quizzes / submissions / roster / kv / outbox
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util;
  var DB_NAME = 'rq-reading-quiz';
  var DB_VER = 1;
  var STORES = ['quizzes', 'submissions', 'roster', 'kv', 'outbox'];

  var _dbp = null;
  var _dbFailed = false;

  /** IndexedDB 可能因為隱私模式、file:// 或瀏覽器限制而無法開啟 → 降級到記憶體 */
  function openDB() {
    if (_dbFailed) return Promise.reject(new Error('IndexedDB 不可用，改用記憶體暫存'));
    if (_dbp) return _dbp;
    _dbp = new Promise(function (res, rej) {
      var settled = false;
      function fail(msg) {
        if (settled) return;
        settled = true; clearTimeout(timer); _dbFailed = true;
        rej(new Error(msg));
      }
      var timer = setTimeout(function () {
        fail('IndexedDB 開啟逾時，改用記憶體暫存');
      }, 3000);

      if (!window.indexedDB) { fail('此瀏覽器不支援 IndexedDB'); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { fail('IndexedDB 開啟失敗：' + e.message); return; }

      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) {
            var os = db.createObjectStore(s, { keyPath: 'id' });
            if (s === 'submissions') {
              os.createIndex('quizId', 'quizId', { unique: false });
              os.createIndex('studentId', 'studentId', { unique: false });
            }
            if (s === 'roster') os.createIndex('username', 'username', { unique: false });
          }
        });
      };
      req.onsuccess = function (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); res(e.target.result);
      };
      req.onerror = function (e) { fail('無法開啟 IndexedDB'); };
      req.onblocked = function () { fail('IndexedDB 被其他分頁鎖住'); };
    });
    return _dbp;
  }

  function tx(store, mode) {
    return openDB().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(os, action) {
    return new Promise(function (res, rej) {
      var req = action(os);
      req.onsuccess = function () { res(req.result); };
      req.onerror = function (e) { rej(e.target.error || new Error('資料庫操作失敗')); };
    });
  }

  /* ---------- 記憶體降級（無 IndexedDB 時） ---------- */
  var _mem = { quizzes: {}, submissions: {}, roster: {}, kv: {}, outbox: {} };

  function fallbackGet(store, id) { return Promise.resolve(_mem[store][id] || null); }
  function fallbackAll(store) { return Promise.resolve(Object.keys(_mem[store]).map(function (k) { return _mem[store][k]; })); }
  function fallbackPut(store, obj) { _mem[store][obj.id] = obj; return Promise.resolve(obj); }
  function fallbackDel(store, id) { delete _mem[store][id]; return Promise.resolve(true); }

  var Store = {
    ready: function () { return openDB(); },

    get: function (store, id) {
      return tx(store, 'readonly').then(function (os) { return wrap(os, function (o) { return o.get(id); }); })
        .catch(function () { return fallbackGet(store, id); });
    },

    all: function (store) {
      return tx(store, 'readonly').then(function (os) { return wrap(os, function (o) { return o.getAll(); }); })
        .catch(function () { return fallbackAll(store); });
    },

    put: function (store, obj) {
      return tx(store, 'readwrite').then(function (os) { return wrap(os, function (o) { return o.put(obj); }); })
        .then(function () { return obj; })
        .catch(function () { return fallbackPut(store, obj); });
    },

    del: function (store, id) {
      return tx(store, 'readwrite').then(function (os) { return wrap(os, function (o) { return o.delete(id); }); })
        .then(function () { return true; })
        .catch(function () { return fallbackDel(store, id); });
    },

    /** 依 index 查詢 */
    byIndex: function (store, index, value) {
      return tx(store, 'readonly').then(function (os) {
        return wrap(os, function (o) { return o.index(index).getAll(value); });
      }).catch(function () {
        return fallbackAll(store).then(function (list) {
          return list.filter(function (x) { return x[index] === value; });
        });
      });
    },

    clear: function (store) {
      return tx(store, 'readwrite').then(function (os) { return wrap(os, function (o) { return o.clear(); }); })
        .catch(function () { _mem[store] = {}; return true; });
    },

    /* ---------- 高階：試卷 ---------- */
    quiz: {
      all: function () { return Store.all('quizzes'); },
      get: function (id) { return Store.get('quizzes', id); },
      save: function (q) { q.updatedAt = U.nowISO(); return Store.put('quizzes', q); },
      del: function (id) { return Store.del('quizzes', id); }
    },

    /* ---------- 高階：作答 ---------- */
    submission: {
      all: function () { return Store.all('submissions'); },
      ofQuiz: function (quizId) { return Store.byIndex('submissions', 'quizId', quizId); },
      ofStudent: function (sid) { return Store.byIndex('submissions', 'studentId', sid); },
      get: function (id) { return Store.get('submissions', id); },
      save: function (s) {
        s.id = s.id || U.uid('sub');
        s.savedAt = U.nowISO();
        return Store.put('submissions', s);
      },
      del: function (id) { return Store.del('submissions', id); }
    },

    /* ---------- 高階：學生名冊 ---------- */
    roster: {
      all: function () { return Store.all('roster'); },
      get: function (id) { return Store.get('roster', id); },
      save: function (u) { u.id = u.id || U.uid('stu'); return Store.put('roster', u); },
      del: function (id) { return Store.del('roster', id); },
      byUsername: function (name) {
        return Store.byIndex('roster', 'username', name).then(function (l) { return l[0] || null; });
      }
    },

    /* ---------- kv（簡單設定） ---------- */
    kv: {
      get: function (k, dflt) {
        return Store.get('kv', k).then(function (r) { return r ? r.value : dflt; });
      },
      set: function (k, v) { return Store.put('kv', { id: k, value: v }); }
    },

    /* ---------- 匯出 / 匯入整包 ---------- */
    exportAll: function () {
      return Promise.all([
        Store.all('quizzes'), Store.all('submissions'), Store.all('roster')
      ]).then(function (r) {
        return {
          format: 'rq-bundle',
          version: 1,
          exportedAt: U.nowISO(),
          quizzes: r[0], submissions: r[1], roster: r[2]
        };
      });
    },

    importAll: function (bundle, mode) {
      // mode: 'merge'（預設，同 id 覆蓋）| 'replace'（先清空）
      var jobs = [];
      var keys = ['quizzes', 'submissions', 'roster'];
      function step(i) {
        if (i >= keys.length) return Promise.resolve(true);
        var k = keys[i];
        var list = bundle[k] || [];
        var p = (mode === 'replace') ? Store.clear(k) : Promise.resolve(true);
        return p.then(function () {
          return list.reduce(function (acc, item) {
            return acc.then(function () { return Store.put(k, item); });
          }, Promise.resolve(true));
        }).then(function () { return step(i + 1); });
      }
      return step(0);
    }
  };

  /* ============================================================
     設定（localStorage）：含 GitHub Token、後端模式等
     ============================================================ */
  var LS_KEY = 'rq.settings.v1';
  var DEFAULT_SETTINGS = {
    /* 試卷存放：offline | github */
    quizMode: 'offline',
    /* 作答收集：offline | webhook | github */
    submitMode: 'offline',
    /* GitHub（老師端同步試卷／封存作答） */
    gh: { owner: '', repo: '', branch: 'main', token: '', path: 'data' },
    /* 收集端（學生提交／註冊／草稿，全部走同一個端點） */
    hook: { postUrl: '', getUrl: '', key: '', sheetUrl: '' },
    /* Firebase Realtime Database（跨裝置雲端同步） */
    fb: { enabled: false, dbUrl: '', apiKey: '', classCode: '' },
    /* 自助註冊 */
    classCode: '',
    allowSelfRegister: false,
    /* 雲端草稿 */
    cloudDraft: true,
    /* 學生端只顯示「老師指派」的試卷（指派後學生才看得到） */
    assignOnly: true,
    /* 老師密碼（"salt:hash"） */
    teacherPass: '',
    /* 學生是否可在提交前看答案 */
    showAnswerAfterSubmit: true,
    /* 允許學生重複作答 */
    allowRetake: false,
    /* 是否啟用螢光筆 */
    enableHighlight: true,
    /* 目前登入者（session） */
    session: null
  };

  var Settings = {
    get: function () {
      var s;
      try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
      catch (e) { s = {}; }
      return Object.assign({}, DEFAULT_SETTINGS, s, {
        gh: Object.assign({}, DEFAULT_SETTINGS.gh, s.gh || {}),
        hook: Object.assign({}, DEFAULT_SETTINGS.hook, s.hook || {}),
        fb: Object.assign({}, DEFAULT_SETTINGS.fb, s.fb || {})
      });
    },
    set: function (patch) {
      var cur = Settings.get();
      var next = Object.assign({}, cur, patch);
      if (patch.gh) next.gh = Object.assign({}, cur.gh, patch.gh);
      if (patch.hook) next.hook = Object.assign({}, cur.hook, patch.hook);
      if (patch.fb) next.fb = Object.assign({}, cur.fb, patch.fb);
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    },
    reset: function () { localStorage.removeItem(LS_KEY); return Settings.get(); },

    /* ---- session ---- */
    login: function (who) { return Settings.set({ session: who }); },
    logout: function () { return Settings.set({ session: null }); },
    who: function () { return Settings.get().session; }
  };

  RQ.store = Store;
  RQ.settings = Settings;
})(window.RQ);
