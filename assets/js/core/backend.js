/* ============================================================
   backend.js — 資料來源抽象層
   ------------------------------------------------------------
   雲端通道（擇一或並存，設定頁切換）：
     A. Firebase Realtime Database  — 即時、跨裝置，免費 Spark 方案
     B. Google Apps Script + 試算表 — 即時寫入、CSV 讀回，免費無上限
     C. GitHub  repo JSON（老師端） — 試卷長期保存
     D. offline IndexedDB + JSON    — 完全離線

   ★ 三種雲端通道共用同一套「記錄模型」，程式碼只有一份：
       rec = { type, id, quizId, studentId, studentName, ts, key, payload }
       type: 'submission' | 'draft' | 'register'
       id  : 'sub::<quizId>::<studentId>' / 'draft::<quizId>::<studentId>' / 'roster::<username>'

   試卷讀取另有「隨站發佈」通道：data/quizzes/*.json 由 GitHub Pages
   靜態提供，學生同源 fetch 即可，不需要任何 Token。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Store = RQ.store, Settings = RQ.settings;

  /* ============================================================
     小工具
     ============================================================ */
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function safeKey(s) {
    return String(s == null ? '' : s).replace(/[.#$\/\[\]?:]/g, '_');
  }
  function recId(type, a, b) {
    if (type === 'submission') return 'sub::' + a + '::' + b;
    if (type === 'draft') return 'draft::' + a + '::' + b;
    if (type === 'register') return 'roster::' + a;
    return type + '::' + a;
  }
  function makeRec(type, a, b, payload, extra) {
    return Object.assign({
      type: type,
      id: recId(type, a, b),
      quizId: type === 'register' ? '' : (a || ''),
      studentId: type === 'register' ? '' : (b || ''),
      studentName: (payload && payload.studentName) || '',
      ts: U.nowISO(),
      key: (Settings.get().hook || {}).key || '',
      payload: payload
    }, extra || {});
  }

  /* ============================================================
     驅動 A：Firebase Realtime Database
     ============================================================ */
  var Firebase = {
    cfg: function () { return Settings.get().fb || {}; },
    ok: function () {
      var c = Firebase.cfg();
      return !!(c.enabled && c.dbUrl && c.apiKey && c.classCode);
    },
    base: function () {
      return 'rq/' + encodeURIComponent(safeKey((Firebase.cfg().classCode || 'default')));
    },
    path: function (p) { return Firebase.base() + (p ? '/' + p : ''); },

    /** 匿名登入，取 idToken（學生不需要有 Google 帳號） */
    signIn: function (force) {
      var c = Firebase.cfg();
      if (!force && c._token && c._exp && Date.now() < c._exp - 60000) return Promise.resolve(c._token);
      return fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' +
        encodeURIComponent(c.apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw new Error((j.error && j.error.message) || '匿名登入失敗');
        Settings.set({ fb: { _token: j.idToken, _exp: Date.now() + (parseInt(j.expiresIn, 10) || 3600) * 1000 } });
        return j.idToken;
      });
    },
    _url: function (p, auth) {
      return String(Firebase.cfg().dbUrl || '').replace(/\/+$/, '') + '/' + p + '.json' +
        (auth ? '?auth=' + encodeURIComponent(auth) : '');
    },
    get: function (p) {
      if (!Firebase.ok()) return Promise.resolve(null);
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), { cache: 'no-store' });
      }).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    },
    put: function (p, val) {
      if (!Firebase.ok()) return Promise.reject(new Error('尚未設定 Firebase'));
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(val)
        });
      }).then(function (r) { if (!r.ok) throw new Error('Firebase 寫入失敗 ' + r.status); return true; });
    },
    del: function (p) {
      if (!Firebase.ok()) return Promise.resolve(true);
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), { method: 'DELETE' });
      }).then(function () { return true; }).catch(function () { return false; });
    },
    test: function () {
      if (!Firebase.ok()) return Promise.reject(new Error('請先填寫 Database URL、API Key 與班級代碼'));
      return Firebase.put('meta/ping', { at: U.nowISO() }).then(function () {
        return Firebase.get('meta/ping');
      }).then(function (v) {
        if (!v) throw new Error('寫入後讀不到資料，請檢查 Realtime Database 規則');
        return { ok: true, at: v.at, base: Firebase.base() };
      });
    }
  };

  /* ============================================================
     驅動 B：Google Apps Script（+ CSV 讀回）
     ============================================================ */
  var Hook = {
    cfg: function () { return Settings.get().hook || {}; },
    ok: function () { return !!Hook.cfg().postUrl; },

    post: function (obj) {
      var c = Hook.cfg();
      if (!c.postUrl) return Promise.reject(new Error('尚未設定收集端網址'));
      var body = JSON.stringify(obj);
      return fetch(c.postUrl, {
        method: 'POST', mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body
      }).then(function (r) {
        return r.json().catch(function () { return { ok: true }; });
      }).then(function (j) {
        if (j && j.ok === false) throw new Error(j.error || '收集端拒絕寫入');
        return true;
      }).catch(function (e) {
        if (e && e.message && /收集端拒絕/.test(e.message)) throw e;
        /* 部分端點不回 CORS 標頭 → 改為單向投遞 */
        return fetch(c.postUrl, {
          method: 'POST', mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body
        }).then(function () { return true; })
          .catch(function () { throw new Error('無法傳送到收集端'); });
      });
    },

    /** 即時讀取（/exec?action=list）；多數情況會被 CORS 擋，失敗回傳 null */
    live: function (type) {
      if (!Hook.ok()) return Promise.resolve(null);
      var url = Hook.cfg().postUrl + '?action=list' + (type ? '&type=' + encodeURIComponent(type) : '');
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) return null;
        return r.json().catch(function () { return null; });
      }).catch(function () { return null; });
    },

    /** 從「發佈成 CSV」的網址讀回（Google 允許跨網域） */
    csv: function () {
      var c = Hook.cfg();
      if (!c.getUrl) return Promise.resolve([]);
      return fetch(c.getUrl + (c.getUrl.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('讀取失敗 ' + r.status); return r.text(); })
        .then(function (txt) {
          var t = U.trim(txt);
          if (t.charAt(0) === '[' || t.charAt(0) === '{') {
            var j = JSON.parse(t);
            return Array.isArray(j) ? j : (j.items || []);
          }
          var rows = U.parseCSV(t);
          if (!rows.length) return [];
          var head = rows[0].map(function (h) { return U.trim(h).toLowerCase(); });
          var pi = head.indexOf('payload');
          if (pi < 0) pi = rows[0].length - 1;
          return rows.slice(1).map(function (r) {
            var raw = U.trim(r[pi] || '');
            if (raw.charAt(0) !== '{') return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
          }).filter(Boolean);
        }).catch(function () { return []; });
    }
  };

  /* ============================================================
     ★ 統一雲端層：Cloud.get / getAll / put / del
     ============================================================ */
  var Cloud = {
    /* 上次讀取走哪條路，給老師端顯示用 */
    lastSource: '',
    lastReadAt: null,

    driver: function () {
      if (Firebase.ok()) return 'firebase';
      if (Hook.ok()) return 'appscript';
      return 'offline';
    },

    put: function (rec) {
      if (Firebase.ok()) {
        rec.id = safeKey(rec.id);
        return Firebase.put(rec.type + '/' + rec.id, rec);
      }
      if (Hook.ok()) return Hook.post(rec);
      return Promise.reject(new Error('尚未設定雲端（Firebase 或收集端網址）'));
    },

    /**
     * 取出某一類的所有記錄（陣列）。
     * Apps Script 路徑：先試 /exec 即時讀取，讀不到再用「發佈成 CSV」。
     * CSV 是 Google 快取的，通常延遲 0–5 分鐘 — 所以要把來源回報給 UI。
     */
    getAll: function (type) {
      if (Firebase.ok()) {
        return Firebase.get(type).then(function (o) {
          Cloud.lastSource = 'firebase';
          Cloud.lastReadAt = U.nowISO();
          if (!o) return [];
          return Object.keys(o).map(function (k) { return o[k]; }).filter(Boolean);
        });
      }
      if (Hook.ok()) {
        return Hook.live(type).then(function (live) {
          if (live !== null) {                   // 即時讀取成功（即使是空陣列）
            Cloud.lastSource = 'live';
            Cloud.lastReadAt = U.nowISO();
            return live;
          }
          return Hook.csv().then(function (rows) {
            Cloud.lastSource = 'csv';            // 走快取，可能延遲
            Cloud.lastReadAt = U.nowISO();
            return rows;
          });
        }).then(function (all) {
          return (all || []).filter(function (r) { return !type || r.type === type; });
        });
      }
      Cloud.lastSource = 'offline';
      return Promise.resolve([]);
    },

    /** 只走即時路徑（/exec），給「強制立即重新整理」用 */
    getAllLive: function (type) {
      if (Firebase.ok()) return Cloud.getAll(type);
      if (!Hook.ok()) return Promise.resolve([]);
      return Hook.live(type).then(function (live) {
        if (live === null) throw new Error('即時讀取被瀏覽器擋住（CORS），請改用 Firebase 或直接開試算表');
        Cloud.lastSource = 'live';
        Cloud.lastReadAt = U.nowISO();
        return (live || []).filter(function (r) { return !type || r.type === type; });
      });
    },

    get: function (type, id) {
      if (Firebase.ok()) return Firebase.get(type + '/' + safeKey(id));
      return Cloud.getAll(type).then(function (list) {
        return list.filter(function (r) { return String(r.id) === String(id); })[0] || null;
      });
    },

    del: function (type, id) {
      if (Firebase.ok()) return Firebase.del(type + '/' + safeKey(id));
      return Promise.resolve(true);
    },

    test: function () {
      if (Firebase.ok()) return Firebase.test().then(function (r) {
        return { driver: 'firebase', detail: r };
      });
      if (Hook.ok()) {
        return Hook.live(null).then(function (live) {
          return { driver: 'appscript', live: !!live, rows: live ? live.length : null };
        });
      }
      return Promise.reject(new Error('尚未設定任何雲端通道'));
    }
  };

  /* ============================================================
     驅動 C：GitHub Contents API（老師端）
     ============================================================ */
  var GitHub = {
    cfg: function () { return Settings.get().gh; },
    ok: function () {
      var c = GitHub.cfg();
      return !!(c.owner && c.repo && c.token);
    },
    api: function (path, opts) {
      opts = opts || {};
      var headers = {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GitHub.cfg().token,
        'X-GitHub-Api-Version': '2022-11-28'
      };
      Object.assign(headers, opts.headers || {});
      return fetch('https://api.github.com' + path, {
        method: opts.method || 'GET', headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        if (r.status === 404) return null;
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.message) || ('GitHub API ' + r.status));
          return j;
        });
      });
    },
    read: function (path) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path +
        '?ref=' + encodeURIComponent(c.branch || 'main')).then(function (j) {
        if (!j) return null;
        return { content: b64decode(j.content), sha: j.sha, path: j.path };
      });
    },
    readJSON: function (path, dflt) {
      return GitHub.read(path).then(function (r) {
        if (!r) return dflt;
        try { return JSON.parse(r.content); } catch (e) { return dflt; }
      });
    },
    write: function (path, objOrText, message) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      var text = (typeof objOrText === 'string') ? objOrText : JSON.stringify(objOrText, null, 2);
      var body = {
        message: message || ('update ' + path),
        content: b64encode(text), branch: c.branch || 'main'
      };
      return GitHub.read(path).then(function (cur) { return cur ? cur.sha : null; })
        .catch(function () { return null; })
        .then(function (sha) {
          if (sha) body.sha = sha;
          return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path, { method: 'PUT', body: body });
        });
    },
    list: function (dir) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + dir +
        '?ref=' + encodeURIComponent(c.branch || 'main'))
        .then(function (j) { return Array.isArray(j) ? j.map(function (f) { return f.name; }) : []; });
    },

    /** 刪除檔案（要先取 sha） */
    remove: function (path, message) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.read(path).then(function (cur) {
        if (!cur) return false;                       // 本來就沒有
        return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path, {
          method: 'DELETE',
          body: { message: message || ('remove ' + path), sha: cur.sha, branch: c.branch || 'main' }
        }).then(function () { return true; });
      });
    },
    test: function () {
      if (!GitHub.ok()) return Promise.reject(new Error('請先填寫擁有者、repo 與 Token'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo).then(function (j) {
        if (!j || !j.full_name) throw new Error('找不到此 repo，或 Token 沒有權限');
        return { full_name: j.full_name, private: j.private, default_branch: j.default_branch };
      });
    }
  };

  /* ============================================================
     隨站發佈通道（同源靜態檔）
     ============================================================ */
  var Published = {
    base: 'data/',
    _fetch: function (rel) {
      return fetch(Published.base + rel + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) return null; return r.json().catch(function () { return null; }); })
        .catch(function () { return null; });
    },
    index: function () { return Published._fetch('quizzes/index.json').then(function (j) { return j || []; }); },
    quiz: function (id) { return Published._fetch('quizzes/' + encodeURIComponent(id) + '.json'); },
    roster: function () { return Published._fetch('roster.json').then(function (j) { return j || []; }); }
  };

  function metaOf(q, src) {
    return {
      id: q.id, title: q.title, level: q.level || '', source: q.source || '',
      questionCount: (q.questions || []).length,
      totalMarks: q.totalMarks || 0,
      passageCount: (q.passages || []).length,
      createdAt: q.createdAt || q.updatedAt || U.nowISO(),
      published: !!q.published,
      assignment: q.assignment || null,
      _src: src
    };
  }

  /* ============================================================
     Backend 統一介面
     ============================================================ */
  var Backend = {
    GitHub: GitHub, Published: Published, Hook: Hook, Firebase: Firebase, Cloud: Cloud,

    /* ---------- 試卷 ---------- */
    listQuizzes: function () {
      var jobs = [Store.quiz.all().catch(function () { return []; }), Published.index()];
      if (Firebase.ok()) jobs.push(Firebase.get('quizzesIndex').then(function (j) { return j || []; }));
      return Promise.all(jobs).then(function (r) {
        var map = {};
        r[0].forEach(function (q) { map[q.id] = metaOf(q, 'local'); });
        (r[1] || []).forEach(function (m) {
          if (!m || !m.id) return;
          if (!map[m.id]) map[m.id] = Object.assign({ _src: 'published' }, m);
          else map[m.id]._src = 'both';
        });
        (r[2] || []).forEach(function (m) {
          if (!m || !m.id) return;
          if (!map[m.id]) map[m.id] = Object.assign({ _src: 'cloud' }, m);
        });
        return Object.keys(map).map(function (k) { return map[k]; })
          .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
      });
    },

    getQuiz: function (id) {
      return Store.quiz.get(id).then(function (q) {
        if (q) return q;
        if (Firebase.ok()) {
          return Firebase.get('quizzes').then(function (o) {
            var found = o && Object.keys(o).filter(function (k) { return o[k] && o[k].id === id; })[0];
            return found ? o[found] : Published.quiz(id);
          });
        }
        return Published.quiz(id);
      }).catch(function () { return Published.quiz(id); });
    },

    saveQuiz: function (quiz) { return Store.quiz.save(quiz).then(function () { return quiz; }); },

    publishQuiz: function (quiz) {
      var jobs = [];
      if (Firebase.ok()) jobs.push(Firebase.put('quizzes/' + safeKey(quiz.id), quiz));
      if (GitHub.ok()) {
        var base = (Settings.get().gh.path || 'data') + '/quizzes';
        jobs.push(GitHub.readJSON(base + '/index.json', []).then(function (idx) {
          var m = metaOf(quiz, 'published');
          var i = idx.findIndex(function (x) { return x.id === quiz.id; });
          if (i >= 0) idx[i] = m; else idx.push(m);
          return GitHub.write(base + '/index.json', idx, 'publish index: ' + quiz.title)
            .then(function () { return GitHub.write(base + '/' + quiz.id + '.json', quiz, 'publish quiz: ' + quiz.title); });
        }));
      }
      if (!jobs.length) return Promise.reject(new Error('請先設定 Firebase 或 GitHub（老師專區 → ⑤ 資料與同步）'));
      return Promise.all(jobs).then(function () {
        quiz.published = true;
        return Store.quiz.save(quiz);
      }).then(function () { return true; });
    },

    /**
     * 刪除試卷。
     * 本機一定刪除；GitHub / Firebase 為 best-effort（失敗也不擋本機）。
     * @param {string} id
     * @param {Object} opt { cloud:bool, github:bool }  是否連雲端 / repo 一起刪
     * @returns {Promise<{ok:boolean, github:?boolean, cloud:?boolean}>}
     */
    deleteQuiz: function (id, opt) {
      opt = opt || {};
      var res = { ok: false, github: null, cloud: null };

      var localJob = Store.quiz.del(id)
        .then(function () { res.ok = true; })
        .catch(function (e) { res.ok = false; throw e; });
      var jobs = [localJob];

      if (opt.cloud && Firebase.ok()) {
        jobs.push(Cloud.del('quizzes', id)
          .then(function (r) { res.cloud = !!r; return r; })
          .catch(function () { res.cloud = false; return false; }));
      }

      if (opt.github && GitHub.ok()) {
        var base = (Settings.get().gh.path || 'data') + '/quizzes';
        jobs.push(
          GitHub.remove(base + '/' + id + '.json', 'delete quiz: ' + id)
            .then(function (r) {
              res.github = !!r;
              return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
                var next = idx.filter(function (m) { return m.id !== id; });
                if (next.length === idx.length) return true;
                return GitHub.write(base + '/index.json', next, 'remove from index: ' + id);
              });
            })
            .catch(function () { res.github = false; return false; })
        );
      }

      return Promise.all(jobs).then(function () { return res; });
    },

    pullQuizzes: function () {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub'));
      var base = (Settings.get().gh.path || 'data') + '/quizzes';
      return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
        return idx.reduce(function (acc, m) {
          return acc.then(function (n) {
            return GitHub.readJSON(base + '/' + m.id + '.json', null).then(function (q) {
              if (!q) return n;
              return Store.quiz.save(q).then(function () { return n + 1; });
            });
          });
        }, Promise.resolve(0));
      });
    },

    /* ---------- 學生名冊 ---------- */
    getRoster: function () {
      var jobs = [Store.roster.all().catch(function () { return []; }), Cloud.getAll('register')];
      if (!Hook.ok() && !Firebase.ok()) jobs[1] = Published.roster();
      return Promise.all(jobs).then(function (r) {
        var map = {};
        (r[1] || []).forEach(function (rec) {
          var s = rec.payload || rec;
          if (s && s.username) map[String(s.username).toLowerCase()] = s;
        });
        (r[0] || []).forEach(function (s) {
          if (s && s.username) {
            var k = String(s.username).toLowerCase();
            map[k] = Object.assign({}, map[k], s);
          }
        });
        return Object.keys(map).map(function (k) { return map[k]; });
      });
    },

    saveStudent: function (stu) { return Backend.registerStudent(stu, true); },

    /** 註冊／建立學生帳號（force=true 表示老師建立，略過班級代碼檢查） */
    registerStudent: function (stu, force) {
      var jobs = [Store.roster.save(stu)];
      var rec = makeRec('register', stu.username, null, stu, {
        classCode: stu.classCode || ''
      });
      if (Firebase.ok() || Hook.ok()) {
        jobs.push(Cloud.put(rec).catch(function (e) {
          if (!force) throw e;
          return true;
        }));
      } else if (!force) {
        /* 沒有雲端也要能註冊（只存在老師這台） */
      }
      return Promise.all(jobs).then(function () { return stu; });
    },

    publishRoster: function (list) {
      var jobs = [];
      if (Firebase.ok() || Hook.ok()) {
        jobs.push(list.reduce(function (acc, s) {
          return acc.then(function () {
            return Cloud.put(makeRec('register', s.username, null, s, { classCode: s.classCode || '' }));
          });
        }, Promise.resolve(true)));
      }
      if (GitHub.ok()) {
        jobs.push(GitHub.write((Settings.get().gh.path || 'data') + '/roster.json', list, 'update roster'));
      }
      if (!jobs.length) return Promise.reject(new Error('請先設定雲端或 GitHub'));
      return Promise.all(jobs).then(function () { return true; });
    },

    /* ---------- 作答草稿（進度雲端同步） ---------- */
    saveDraft: function (sub) {
      var key = 'draft:' + sub.quizId + ':' + sub.studentId;
      sub.savedAt = U.nowISO();
      var jobs = [Store.kv.set(key, sub)];
      if (Firebase.ok() || Hook.ok()) {
        jobs.push(Cloud.put(makeRec('draft', sub.quizId, sub.studentId, sub)));
      }
      return Promise.all(jobs).then(function () { return true; });
    },

    getDraft: function (quizId, studentId) {
      var local = Store.kv.get('draft:' + quizId + ':' + studentId, null);
      if (Cloud.driver() === 'offline') return local;
      var remote = Cloud.get('draft', recId('draft', quizId, studentId))
        .then(function (rec) { return rec ? (rec.payload || rec) : null; })
        .catch(function () { return null; });
      return Promise.all([local, remote]).then(function (r) {
        var a = r[0], b = r[1];
        if (!a) return b; if (!b) return a;
        return (String(b.savedAt || '') > String(a.savedAt || '')) ? b : a;
      });
    },

    clearDraft: function (quizId, studentId) {
      var jobs = [Store.kv.set('draft:' + quizId + ':' + studentId, null)];
      if (Firebase.ok()) jobs.push(Cloud.del('draft', recId('draft', quizId, studentId)));
      return Promise.all(jobs).then(function () { return true; });
    },

    /* ---------- 作答 ---------- */
    saveSubmission: function (sub) {
      return Store.submission.save(sub).then(function (s) {
        if (Firebase.ok() || Hook.ok()) {
          return Cloud.put(makeRec('submission', s.quizId, s.studentId, s))
            .then(function () { s._synced = Cloud.driver(); delete s._pending; })
            .catch(function (e) { s._syncError = e.message; s._pending = true; })
            .then(function () { return Store.submission.save(s); });
        }
        if (Settings.get().submitMode === 'github' && GitHub.ok()) {
          var p2 = (Settings.get().gh.path || 'data') + '/submissions/' +
            safeKey(s.quizId) + '/' + safeKey(s.studentId) + '.json';
          return GitHub.write(p2, s, 'submission: ' + (s.studentName || s.studentId))
            .then(function () { s._synced = 'github'; delete s._pending; })
            .catch(function (e) { s._syncError = e.message; s._pending = true; })
            .then(function () { return Store.submission.save(s); });
        }
        s._synced = 'local';
        return Store.submission.save(s);
      });
    },

    listSubmissions: function (quizId) {
      var jobs = [Store.submission.all().catch(function () { return []; }), Cloud.getAll('submission')];
      if (Settings.get().submitMode === 'github' && GitHub.ok()) {
        jobs.push(Backend._ghSubmissions(quizId).catch(function () { return []; }));
      }
      return Promise.all(jobs).then(function (g) {
        var map = {};
        function add(s) {
          if (!s || !s.id) return;
          var key = s.quizId + '::' + s.studentId + '::' + (s.attempt || 1);
          var old = map[key];
          if (!old || String(s.submittedAt || '') > String(old.submittedAt || '')) map[key] = s;
        }
        (g[0] || []).forEach(add);
        (g[1] || []).forEach(function (rec) { add(rec.payload || rec); });
        (g[2] || []).forEach(add);
        var out = Object.keys(map).map(function (k) { return map[k]; });
        if (quizId) out = out.filter(function (s) { return s.quizId === quizId; });
        return out.sort(function (a, b) {
          return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
        });
      });
    },

    /** 取某學生某份試卷的最新作答：合併本機與雲端，雲端（含老師批改）優先 */
    getSubmission: function (quizId, studentId) {
      var localP = Store.submission.ofStudent(studentId).then(function (list) {
        return (list || []).filter(function (s) { return s.quizId === quizId; })
          .sort(function (a, b) { return String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')); })[0] || null;
      }).catch(function () { return null; });
      var cloudP = (Firebase.ok() || Hook.ok())
        ? Cloud.get('submission', recId('submission', quizId, studentId))
          .then(function (rec) { return rec && (rec.payload || rec); })
          .catch(function () { return null; })
        : Promise.resolve(null);
      return Promise.all([localP, cloudP]).then(function (r) {
        var loc = r[0], cloud = r[1];
        if (!loc) return cloud;
        if (!cloud) return loc;
        var merged = Object.assign({}, loc, cloud);
        var ans = {};
        Object.keys(loc.answers || {}).concat(Object.keys(cloud.answers || {})).forEach(function (k) {
          ans[k] = Object.assign({}, (loc.answers || {})[k], (cloud.answers || {})[k]);
        });
        merged.answers = ans;
        merged.score = Object.assign({}, loc.score, cloud.score);
        merged.id = loc.id;
        merged.submittedAt = loc.submittedAt || cloud.submittedAt;
        return merged;
      });
    },

    _ghSubmissions: function (quizId) {
      var base = (Settings.get().gh.path || 'data') + '/submissions';
      var p = quizId ? Promise.resolve([quizId]) : GitHub.list(base).catch(function () { return []; });
      return p.then(function (list) {
        return list.reduce(function (acc, d) {
          return acc.then(function (arr) {
            return GitHub.list(base + '/' + d).catch(function () { return []; }).then(function (files) {
              return files.filter(function (f) { return /\.json$/.test(f); })
                .reduce(function (a2, f) {
                  return a2.then(function (arr2) {
                    return GitHub.readJSON(base + '/' + d + '/' + f, null)
                      .then(function (s) { if (s) arr2.push(s); return arr2; });
                  });
                }, Promise.resolve(arr));
            });
          });
        }, Promise.resolve([]));
      });
    },

    retryPending: function () {
      return Store.all('submissions').then(function (list) {
        var pend = list.filter(function (s) { return s._pending; });
        return pend.reduce(function (acc, s) {
          return acc.then(function (n) {
            return Backend.saveSubmission(s).then(function (x) { return n + (x._pending ? 0 : 1); });
          });
        }, Promise.resolve(0));
      });
    },

    archiveSubmissions: function (quizId) {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub'));
      return Store.submission.all().then(function (list) {
        var sel = quizId ? list.filter(function (s) { return s.quizId === quizId; }) : list;
        var base = (Settings.get().gh.path || 'data') + '/submissions';
        return sel.reduce(function (acc, s) {
          return acc.then(function (n) {
            return GitHub.write(base + '/' + safeKey(s.quizId) + '/' + safeKey(s.studentId) + '.json', s,
              'archive: ' + (s.studentName || s.studentId)).then(function () { return n + 1; });
          });
        }, Promise.resolve(0));
      });
    }
  };

  RQ.backend = Backend;
})(window.RQ);
