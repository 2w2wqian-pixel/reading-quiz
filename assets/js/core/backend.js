/* ============================================================
   backend.js — 資料來源抽象層
   ------------------------------------------------------------
   三種模式（可在「設定」頁自由切換、並存）：
     1. offline  ：IndexDB / localStorage，完全離線，JSON 匯出匯入
     2. github   ：用 Personal Access Token 讀寫 repo 內的 JSON
                   （Token 只存在本機 localStorage，不寫死在程式碼）
     3. webhook  ：把作答 POST 到免費收集端（Google Apps Script 等）

   試卷讀取另有「隨站發佈」通道：老師把 JSON 放進 repo 的 data/quizzes/，
   GitHub Pages 會以靜態檔提供，學生端同源直接 fetch，不需任何 Token。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Store = RQ.store, Settings = RQ.settings;

  /* ============================================================
     GitHub Contents API
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

  var GitHub = {
    cfg: function () { return Settings.get().gh; },

    ok: function () {
      var c = GitHub.cfg();
      return !!(c.owner && c.repo && c.token);
    },

    api: function (path, opts) {
      opts = opts || {};
      var url = 'https://api.github.com' + path;
      var headers = {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GitHub.cfg().token,
        'X-GitHub-Api-Version': '2022-11-28'
      };
      Object.assign(headers, opts.headers || {});
      return fetch(url, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        if (r.status === 404) return null;
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.message) || ('GitHub API ' + r.status));
          return j;
        });
      });
    },

    /** 讀檔，回傳 {content, sha} 或 null */
    read: function (path) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub（擁有者／repo／Token）'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path +
        '?ref=' + encodeURIComponent(c.branch || 'main'))
        .then(function (j) {
          if (!j) return null;
          return { content: b64decode(j.content), sha: j.sha, path: j.path };
        });
    },

    /** 讀 JSON 檔，失敗回傳 dflt */
    readJSON: function (path, dflt) {
      return GitHub.read(path).then(function (r) {
        if (!r) return dflt;
        try { return JSON.parse(r.content); } catch (e) { return dflt; }
      });
    },

    /** 寫檔（新增或更新） */
    write: function (path, objOrText, message) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub（擁有者／repo／Token）'));
      var c = GitHub.cfg();
      var text = (typeof objOrText === 'string') ? objOrText
        : JSON.stringify(objOrText, null, 2);
      var body = {
        message: message || ('update ' + path + ' — ' + U.fmtDate(U.nowISO(), true)),
        content: b64encode(text),
        branch: c.branch || 'main'
      };
      return GitHub.read(path).then(function (cur) { return cur ? cur.sha : null; })
        .catch(function () { return null; })
        .then(function (sha) {
          if (sha) body.sha = sha;
          return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path, {
            method: 'PUT', body: body
          });
        });
    },

    /** 列出目錄 */
    list: function (dir) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + dir +
        '?ref=' + encodeURIComponent(c.branch || 'main'))
        .then(function (j) { return Array.isArray(j) ? j.map(function (f) { return f.name; }) : []; });
    },

    /** 測試連線 */
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
     隨站發佈通道（同源靜態檔，人人可讀，不需 Token）
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

  /* ============================================================
     Webhook / Apps Script 收集端
     ============================================================ */
  var Hook = {
    cfg: function () { return Settings.get().hook; },

    /** 送出一次作答。Apps Script 用 text/plain 避免 CORS 預檢。 */
    post: function (payload) {
      var c = Hook.cfg();
      if (!c.postUrl) return Promise.reject(new Error('尚未設定收集端網址'));
      var body = JSON.stringify(payload);
      return fetch(c.postUrl, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body
      }).then(function (r) { return { ok: true, status: r.status }; })
        .catch(function () {
          // 某些收集端（含 Apps Script）不回 CORS 標頭 → 改為單向投遞
          return fetch(c.postUrl, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body
          }).then(function () { return { ok: true, status: 'no-cors' }; });
        });
    },

    /** 讀回所有作答（老師端）。支援 JSON 陣列 或 Google 試算表發佈的 CSV。 */
    list: function () {
      var c = Hook.cfg();
      if (!c.getUrl) return Promise.resolve([]);
      return fetch(c.getUrl + (c.getUrl.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(),
        { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('讀取失敗 ' + r.status); return r.text(); })
        .then(function (txt) {
          var t = U.trim(txt);
          if (t.charAt(0) === '[' || t.charAt(0) === '{') {
            var j = JSON.parse(t);
            return Array.isArray(j) ? j : (j.items || j.submissions || []);
          }
          // CSV：最後一欄放完整 JSON
          var rows = U.parseCSV(t);
          if (!rows.length) return [];
          var head = rows[0].map(function (h) { return U.trim(h).toLowerCase(); });
          var pi = head.indexOf('payload');
          if (pi < 0) pi = rows[0].length - 1;
          return rows.slice(1).map(function (r) {
            var raw = U.trim(r[pi] || '');
            if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
              try { return JSON.parse(raw); } catch (e) { return null; }
            }
            return null;
          }).filter(Boolean);
        });
    }
  };

  /* ============================================================
     Backend 統一介面
     ============================================================ */
  var Backend = {
    GitHub: GitHub,
    Published: Published,
    Hook: Hook,

    /* ---------- 試卷 ---------- */

    /** 合併「本機 IndexedDB」+「隨站發佈」的試卷清單 */
    listQuizzes: function () {
      var locals = Store.quiz.all().catch(function () { return []; });
      var pubs = Published.index();
      return Promise.all([locals, pubs]).then(function (r) {
        var map = {};
        r[0].forEach(function (q) { map[q.id] = metaOf(q, 'local'); });
        (r[1] || []).forEach(function (m) {
          if (!m || !m.id) return;
          if (!map[m.id]) map[m.id] = Object.assign({ _src: 'published' }, m);
          else map[m.id]._src = 'both';
        });
        return Object.keys(map).map(function (k) { return map[k]; })
          .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
      });
    },

    getQuiz: function (id) {
      return Store.quiz.get(id).then(function (q) {
        if (q) return q;
        return Published.quiz(id);
      }).catch(function () { return Published.quiz(id); });
    },

    saveQuiz: function (quiz) {
      return Store.quiz.save(quiz).then(function () { return quiz; });
    },

    /** 老師端：把試卷寫進 GitHub repo，並更新 index.json */
    publishQuiz: function (quiz) {
      if (!GitHub.ok()) return Promise.reject(new Error('請先在「設定」填入 GitHub 資料與 Token'));
      var base = (Settings.get().gh.path || 'data') + '/quizzes';
      var idxPath = base + '/index.json';
      return GitHub.readJSON(idxPath, []).then(function (idx) {
        var meta = metaOf(quiz, 'published');
        var i = idx.findIndex(function (m) { return m.id === quiz.id; });
        if (i >= 0) idx[i] = meta; else idx.push(meta);
        return GitHub.write(idxPath, idx, 'publish index: ' + quiz.title)
          .then(function () {
            return GitHub.write(base + '/' + quiz.id + '.json', quiz, 'publish quiz: ' + quiz.title);
          });
      }).then(function () {
        // 本機也留一份
        return Store.quiz.save(quiz);
      }).then(function () { return true; });
    },

    /** 老師端：從 repo 把試卷拉回本機 */
    pullQuizzes: function () {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub'));
      var base = (Settings.get().gh.path || 'data') + '/quizzes';
      return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
        if (!idx.length) return 0;
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
      return Store.roster.all().then(function (local) {
        if (local && local.length) return local;
        return Published.roster();
      }).catch(function () { return []; });
    },

    saveStudent: function (stu) { return Store.roster.save(stu); },

    publishRoster: function (list) {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub'));
      var path = (Settings.get().gh.path || 'data') + '/roster.json';
      return GitHub.write(path, list, 'update roster');
    },

    /* ---------- 作答 ---------- */
    saveSubmission: function (sub) {
      // 1. 永遠先存本機（離線可用、可匯出）
      return Store.submission.save(sub).then(function (s) {
        var mode = Settings.get().submitMode;
        if (mode === 'github' && GitHub.ok()) {
          var path = (Settings.get().gh.path || 'data') + '/submissions/' +
            (sub.quizId || 'unknown') + '/' + (sub.studentId || 'anon') + '.json';
          return GitHub.write(path, sub, 'submission: ' + (sub.studentName || sub.studentId))
            .then(function () { s._synced = 'github'; return Store.submission.save(s); })
            .catch(function (e) { s._syncError = e.message; return Store.submission.save(s); });
        }
        if (mode === 'webhook' && Hook.cfg().postUrl) {
          return Hook.post(s).then(function () { s._synced = 'webhook'; return Store.submission.save(s); })
            .catch(function (e) {
              s._syncError = e.message;
              s._pending = true;
              return Store.submission.save(s);
            });
        }
        return s;
      });
    },

    /** 老師端：彙整所有作答（本機 + webhook + github） */
    listSubmissions: function (quizId) {
      var jobs = [];
      jobs.push(Store.submission.all().catch(function () { return []; }));
      if (Settings.get().submitMode === 'webhook' && Hook.cfg().getUrl) {
        jobs.push(Hook.list().catch(function () { return []; }));
      }
      if (Settings.get().submitMode === 'github' && GitHub.ok()) {
        jobs.push(Backend._ghSubmissions(quizId).catch(function () { return []; }));
      }
      return Promise.all(jobs).then(function (groups) {
        var map = {};
        groups.forEach(function (list) {
          (list || []).forEach(function (s) {
            if (!s || !s.id) return;
            var key = s.quizId + '::' + s.studentId + '::' + (s.attempt || 1);
            var old = map[key];
            if (!old || String(s.submittedAt || '') > String(old.submittedAt || '')) map[key] = s;
          });
        });
        var out = Object.keys(map).map(function (k) { return map[k]; });
        if (quizId) out = out.filter(function (s) { return s.quizId === quizId; });
        return out.sort(function (a, b) {
          return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
        });
      });
    },

    _ghSubmissions: function (quizId) {
      var base = (Settings.get().gh.path || 'data') + '/submissions';
      var dirs = quizId ? [quizId] : null;
      var p = dirs ? Promise.resolve(dirs) : GitHub.list(base).catch(function () { return []; });
      return p.then(function (list) {
        return list.reduce(function (acc, d) {
          return acc.then(function (arr) {
            return GitHub.list(base + '/' + d).catch(function () { return []; })
              .then(function (files) {
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

    /** 重試尚未同步的作答 */
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

    /** 老師端：把本機作答封存進 repo（一個學生一個檔案） */
    archiveSubmissions: function (quizId) {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub'));
      return Store.submission.all().then(function (list) {
        var sel = quizId ? list.filter(function (s) { return s.quizId === quizId; }) : list;
        var base = (Settings.get().gh.path || 'data') + '/submissions';
        return sel.reduce(function (acc, s) {
          return acc.then(function (n) {
            return GitHub.write(base + '/' + s.quizId + '/' + s.studentId + '.json', s,
              'archive: ' + (s.studentName || s.studentId)).then(function () { return n + 1; });
          });
        }, Promise.resolve(0));
      });
    }
  };

  function metaOf(q, src) {
    return {
      id: q.id,
      title: q.title,
      level: q.level || '',
      source: q.source || '',
      questionCount: (q.questions || []).length,
      totalMarks: q.totalMarks || 0,
      passageCount: (q.passages || []).length,
      createdAt: q.createdAt || q.updatedAt || U.nowISO(),
      published: !!q.published,
      _src: src
    };
  }

  RQ.backend = Backend;
})(window.RQ);
