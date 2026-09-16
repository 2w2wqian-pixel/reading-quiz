/* ============================================================
   app.js — 路由、首頁、共用設定頁
   路由： #/  #/student  #/quiz/:id  #/result/:id
         #/teacher[/tab]  #/edit/:id  #/settings
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Settings = RQ.settings, Store = RQ.store, Backend = RQ.backend;
  var view, whoEl;

  function route() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(function (x) { return x !== ''; });
    var page = parts[0] || 'home';
    var arg = parts[1] || null;

    U.$$('.nav-link').forEach(function (a) { a.classList.remove('active'); });
    var navKey = ({ home: 'home', student: 'student', teacher: 'teacher', settings: 'settings', quiz: 'student', result: 'student', edit: 'teacher' })[page];
    var navEl = U.$('.nav-link[data-route="' + navKey + '"]');
    if (navEl) navEl.classList.add('active');

    renderWho();
    view.scrollTop = 0;

    switch (page) {
      case 'home': home(); break;
      case 'student':
        var who = Settings.who();
        if (!who || who.role !== 'student') RQ.student.login(view);
        else RQ.student.home(view);
        break;
      case 'quiz': requireStudent(function () { RQ.student.take(view, arg); }); break;
      case 'result': requireStudent(function () { RQ.student.result(view, arg); }); break;
      case 'teacher': RQ.teacher.render(view, arg); break;
      case 'edit': requireTeacher(function () { RQ.teacher.edit(view, arg); }); break;
      case 'settings': settings(); break;
      default: home();
    }
  }

  function requireStudent(fn) {
    var who = Settings.who();
    if (!who || who.role !== 'student') { location.hash = '#/student'; return; }
    fn();
  }
  function requireTeacher(fn) {
    var who = Settings.who();
    if (!who || who.role !== 'teacher') { location.hash = '#/teacher'; return; }
    fn();
  }

  function renderWho() {
    var who = Settings.who();
    whoEl.innerHTML = '';
    if (!who) {
      whoEl.appendChild(U.el('span.chip', { text: '未登入' }));
      return;
    }
    whoEl.appendChild(U.el('span.chip', {
      text: (who.role === 'teacher' ? '👩‍🏫 老師' : '🧒 ' + (who.name || '學生'))
    }));
    whoEl.appendChild(U.el('button.btn.xs.ghost', {
      text: '登出', onclick: function () {
        Settings.logout();
        U.toast('已登出');
        location.hash = '#/';
        renderWho();
      }
    }));
  }

  /* ============================================================
     首頁
     ============================================================ */
  function home() {
    var who = Settings.who();
    view.innerHTML = '';

    view.appendChild(U.el('div.hero', {}, [
      U.el('h1', { text: '上傳 Word 試卷，立刻變成線上閱讀測驗' }),
      U.el('p', {
        html: '老師上傳 .docx → 自動拆成文章、題目、選項與答案 → 學生登入作答 → ' +
          '可在文章上<b>螢光標示、寫筆記、收集生詞</b> → 老師一次看到所有人的作答與學習痕跡。'
      }),
      U.el('div.row.mt2', {}, [
        U.el('a.btn.primary', { href: '#/teacher/upload', text: '我是老師：上傳試卷' }),
        U.el('a.btn.mint', { href: '#/student', text: '我是學生：開始作答' }),
        U.el('a.btn.ghost', { href: '#/settings', text: '設定' })
      ])
    ]));

    if (!who) {
      view.appendChild(U.el('div.card.mt3', {}, [
        U.el('h3', { text: '第一次使用？' }),
        U.el('div.grid.g3', {}, [
          step(1, '老師上傳試卷', '把 Word 檔拖進去，程式會自動拆解；有誤差可在編輯頁逐題微調。'),
          step(2, '設定學生帳號', '在「④ 學生名冊」建立帳號，或讓學生自己用班級代碼。'),
          step(3, '學生作答與標記', '學生登入後作答，可畫重點、加筆記、把不懂的詞收進生詞本。')
        ])
      ]));
    }

    /* 可用試卷 */
    var box = U.el('div.mt3');
    view.appendChild(box);
    Backend.listQuizzes().then(function (list) {
      box.innerHTML = '';
      box.appendChild(U.el('h2', { text: '可作答的試卷（' + list.length + '）' }));
      if (!list.length) {
        box.appendChild(U.el('div.empty', {}, [
          U.el('div.big', { text: '📚' }),
          U.el('small', { text: '尚無試卷，請老師先上傳。' })
        ]));
        return;
      }
      var grid = U.el('div.grid.g3');
      list.forEach(function (m) {
        grid.appendChild(U.el('div.card.mb0', {}, [
          U.el('h3.mb0', { html: U.esc(m.title) }),
          U.el('div.tiny.muted.mt1', { text: (m.level ? m.level + '・' : '') + (m.questionCount || 0) + ' 題・' + (m.totalMarks || 0) + ' 分' }),
          U.el('div.row.mt2', {}, [
            U.el('a.btn.sm.primary', { href: '#/quiz/' + m.id, text: '開始作答' })
          ])
        ]));
      });
      box.appendChild(grid);
    });

    /* 部署與安全提示 */
    view.appendChild(U.el('div.card.tinted.mt3', {}, [
      U.el('h3', { text: '資料放在哪裡？' }),
      U.el('div.tiny', {
        html: [
          '<b>試卷</b>：以 JSON 放在 repo 的 <code>data/quizzes/</code>，由 GitHub Pages 直接提供，學生讀取不需要任何 Token。',
          '<b>老師寫入</b>：用 Personal Access Token 經 GitHub API 上傳；Token 只存在老師自己瀏覽器的 localStorage。',
          '<b>學生作答</b>：免費收集端（建議 Google Apps Script→Google 試算表，無流量上限），或完全離線的 JSON 匯出匯入。',
          '<b>更安全的做法</b>：① 用 fine-grained token 只授權單一 repo、並設到期日；② Token 不要貼給學生；' +
          '③ 若學生會共用電腦，登入後記得登出；④ 這是課堂工具，不是銀行等級的身分驗證，請勿放敏感個資。'
        ].map(function (x) { return '<div style="padding:3px 0">' + x + '</div>'; }).join('')
      })
    ]));
  }

  function step(n, title, desc) {
    return U.el('div.step', {}, [
      U.el('div.n', { text: String(n) }),
      U.el('div', {}, [U.el('b', { text: title }), U.el('div.tiny.muted', { text: desc })])
    ]);
  }

  /* ============================================================
     設定頁（老師與學生共用）
     ============================================================ */
  function settings() {
    view.innerHTML = '';
    var s = Settings.get();

    var card = U.el('div.card');
    card.appendChild(U.el('h2', { text: '設定' }));

    var mode = U.el('select.input', { style: { maxWidth: '280px' } });
    [['offline', '只存本機（完全離線）'], ['github', '同步到 GitHub repo']].forEach(function (x) {
      mode.appendChild(U.el('option', { value: x[0], text: x[1] }));
    });
    mode.value = s.quizMode || 'offline';
    card.appendChild(U.el('div', {}, [U.el('label.tiny.muted', { text: '試卷存放方式' }), mode]));

    var hi = U.el('input', { type: 'checkbox' });
    hi.checked = s.enableHighlight !== false;
    var ans = U.el('input', { type: 'checkbox' });
    ans.checked = s.showAnswerAfterSubmit !== false;
    var rt = U.el('input', { type: 'checkbox' });
    rt.checked = !!s.allowRetake;

    card.appendChild(U.el('div.mt2', {},
      [
        [hi, '啟用螢光標示／筆記／生詞本'],
        [ans, '學生提交後可查看正確答案'],
        [rt, '允許學生重複作答同一份試卷']
      ].map(function (x) {
        return U.el('label.check', { style: { display: 'flex', marginBottom: '6px' } }, [x[0], U.el('span', { text: x[1] })]);
      })
    ));

    card.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存設定', onclick: function () {
          Settings.set({
            quizMode: mode.value,
            enableHighlight: hi.checked,
            showAnswerAfterSubmit: ans.checked,
            allowRetake: rt.checked
          });
          U.toast('已儲存', 'ok');
        }
      }),
      U.el('a.btn.sm', { href: '#/teacher/data', text: '進階：GitHub 與收集端' })
    ]));
    view.appendChild(card);

    /* 本機資料總覽 */
    var stat = U.el('div.card');
    view.appendChild(stat);
    Promise.all([Store.all('quizzes'), Store.all('submissions'), Store.all('roster')]).then(function (r) {
      stat.innerHTML = '';
      stat.appendChild(U.el('h3', { text: '本機資料' }));
      var g = U.el('div.grid.g3');
      [['試卷', r[0].length], ['作答記錄', r[1].length], ['學生帳號', r[2].length]].forEach(function (x) {
        g.appendChild(U.el('div.stat', {}, [U.el('b', { text: String(x[1]) }), U.el('span', { text: x[0] })]));
      });
      stat.appendChild(g);
      stat.appendChild(U.el('div.row.mt2', {}, [
        U.el('button.btn.sm', {
          text: '匯出全部（JSON）', onclick: function () {
            Store.exportAll().then(function (b) { U.download('rq-backup-' + U.fmtDate(U.nowISO()) + '.json', JSON.stringify(b, null, 2)); });
          }
        }),
        U.el('button.btn.sm.danger', {
          text: '清空本機資料', onclick: function () {
            U.confirm('這會清除這台電腦上所有試卷、作答與名冊，確定嗎？', function () {
              Promise.all([Store.clear('quizzes'), Store.clear('submissions'), Store.clear('roster')])
                .then(function () { U.toast('已清空'); route(); });
            });
          }
        })
      ]));
    });
  }

  /* ============================================================
     啟動
     ============================================================ */
  function boot() {
    view = document.getElementById('view');
    whoEl = document.getElementById('who');

    if (!window.indexedDB) {
      U.toast('此瀏覽器不支援 IndexedDB，將改用記憶體暫存（關閉分頁即消失）', 'bad', 4200);
    }

    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/';
    route();

    /* 供偵錯 */
    window.RQ.debug = { store: Store, settings: Settings, backend: Backend };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  RQ.route = route;
})(window.RQ);
