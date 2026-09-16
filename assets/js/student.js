/* ============================================================
   student.js — 學生端：登入 / 作答 / 對答案 / 螢光筆 / 生詞本
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Store = RQ.store, Settings = RQ.settings, Backend = RQ.backend;

  /* ============================================================
     表單元件（老師端預覽也會用到）
     ============================================================ */
  var Forms = {};

  /** 渲染一題的作答介面。ans = submission.answers[qid] */
  Forms.input = function (q, ans, opts) {
    opts = opts || {};
    ans = ans || {};
    var wrap = U.el('div.q-input');
    var disabled = !!opts.disabled;

    if (q.type === 'mcq') {
      var box = U.el('div.opts');
      var val = Array.isArray(ans.value) ? ans.value.slice() : (ans.value ? [ans.value] : []);
      (q.options || []).forEach(function (o) {
        var checked = val.indexOf(o.key) >= 0;
        var item = U.el('label.opt' + (checked ? '.checked' : ''));
        var input = U.el('input', {
          type: (q.multi ? 'checkbox' : 'radio'),
          name: 'q_' + (opts.uid || '') + q.id,
          value: o.key,
          style: { display: 'none' }
        });
        input.checked = checked;
        if (disabled) input.disabled = true;
        item.appendChild(input);
        item.appendChild(U.el('span.key', { text: o.key }));
        item.appendChild(U.el('span', { html: U.esc(o.text) }));
        if (!disabled) {
          input.addEventListener('change', function () {
            if (!q.multi) {
              val = [o.key];
              U.$$('input', box).forEach(function (i) { i.checked = (i.value === o.key); });
              U.$$('.opt', box).forEach(function (el, i2) {
                el.classList.toggle('checked', i2 === (q.options || []).map(function (x) { return x.key; }).indexOf(o.key));
              });
            } else {
              if (input.checked) { if (val.indexOf(o.key) < 0) val.push(o.key); }
              else val = val.filter(function (x) { return x !== o.key; });
              item.classList.toggle('checked', input.checked);
            }
            val.sort();
            opts.onChange && opts.onChange({ value: val });
          });
        }
        box.appendChild(item);
      });
      if (q.multi) {
        box.appendChild(U.el('div.tiny.faint', { text: '（本題可複選）' }));
      }
      wrap.appendChild(box);

    } else if (q.type === 'table' && (q.subQuestions || []).length) {
      var sub = ans.sub || {};
      q.subQuestions.forEach(function (s) {
        var row = U.el('div.subq');
        row.appendChild(U.el('div.sublbl', { html: U.esc(s.label || '') + (s.prompt ? '　' + U.nl2br(s.prompt) : '') }));
        if (s.kind === 'tick' && (s.choices || []).length) {
          var sel = U.el('select.input');
          sel.appendChild(U.el('option', { value: '', text: '— 請選擇 —' }));
          s.choices.forEach(function (c) { sel.appendChild(U.el('option', { value: c, text: c })); });
          sel.value = sub[s.id] || '';
          if (disabled) sel.disabled = true;
          else sel.addEventListener('change', function () {
            sub[s.id] = sel.value;
            opts.onChange && opts.onChange({ sub: sub });
          });
          row.appendChild(sel);
        } else {
          var ta2 = U.el('textarea.input', { rows: 2 });
          ta2.value = sub[s.id] || '';
          if (disabled) ta2.disabled = true;
          else ta2.addEventListener('input', U.debounce(function () {
            sub[s.id] = ta2.value;
            opts.onChange && opts.onChange({ sub: sub });
          }, 300));
          row.appendChild(ta2);
        }
        wrap.appendChild(row);
      });

    } else {
      var ta = U.el('textarea.input', { rows: q.type === 'table' ? 4 : 3, placeholder: '請在此作答…' });
      ta.value = ans.value || '';
      if (disabled) ta.disabled = true;
      else ta.addEventListener('input', U.debounce(function () {
        opts.onChange && opts.onChange({ value: ta.value });
      }, 300));
      wrap.appendChild(ta);
    }
    return wrap;
  };

  /** 作答結果純文字化（老師報表用） */
  Forms.answerText = function (q, ans) {
    ans = ans || {};
    if (q.type === 'mcq') {
      var v = Array.isArray(ans.value) ? ans.value : (ans.value ? [ans.value] : []);
      return v.map(function (k) {
        var o = (q.options || []).filter(function (x) { return x.key === k; })[0];
        return k + (o ? '. ' + o.text : '');
      }).join('、') || '（未作答）';
    }
    if (q.type === 'table' && (q.subQuestions || []).length) {
      var sub = ans.sub || {};
      return q.subQuestions.map(function (s) {
        return (s.label ? s.label + '：' : '') + (sub[s.id] || '（空白）');
      }).join('\n');
    }
    return ans.value || '（未作答）';
  };

  /** 自動批改：只有選擇題能自動 */
  Forms.autoScore = function (q, ans) {
    if (q.type !== 'mcq' || !q.answerKeys || !q.answerKeys.length) return null;
    var v = (ans && Array.isArray(ans.value)) ? ans.value.slice().sort() : [];
    var k = q.answerKeys.slice().sort();
    if (v.length !== k.length) return 0;
    for (var i = 0; i < k.length; i++) if (v[i] !== k[i]) return 0;
    return q.marks || 0;
  };

  /** 顯示正確答案 */
  Forms.reveal = function (q, ans) {
    var box = U.el('div.reveal');
    var got = Forms.autoScore(q, ans);
    box.appendChild(U.el('div.k', {
      text: got === null ? '參考答案' : (got > 0 ? '✔ 答對（' + got + ' / ' + (q.marks || 0) + ' 分）' : '✘ 答錯')
    }));
    if (q.type === 'mcq') {
      box.appendChild(U.el('div', {
        html: '正確選項：<b>' + U.esc((q.answerKeys || []).join('、') || '—') + '</b>' +
          (q.answer ? '　' + U.nl2br(q.answer) : '')
      }));
    } else if (q.type === 'table' && (q.subQuestions || []).length) {
      var sub = (ans && ans.sub) || {};
      var tbl = U.el('table.tbl');
      tbl.innerHTML = '<thead><tr><th>子題</th><th>你的作答</th><th>參考答案</th></tr></thead>';
      var tb = U.el('tbody');
      q.subQuestions.forEach(function (s) {
        var tr = U.el('tr');
        tr.appendChild(U.el('td', { html: U.esc(s.label || '') }));
        tr.appendChild(U.el('td', { html: U.nl2br(sub[s.id] || '—') }));
        tr.appendChild(U.el('td', { html: U.nl2br(s.answer || '—') }));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      box.appendChild(tbl);
      if (q.answer) box.appendChild(U.el('div', { html: U.nl2br(q.answer), class: 'mt1' }));
    } else {
      box.appendChild(U.el('div', { html: U.nl2br(q.answer || '（尚未提供答案）') }));
    }
    if (q.explanation) {
      box.appendChild(U.el('div.mt1.tiny', { html: '<b>解析：</b>' + U.nl2br(q.explanation) }));
    }
    return box;
  };

  RQ.forms = Forms;

  /* ============================================================
     學生端頁面
     ============================================================ */
  var Student = {};

  Student.login = function (view) {
    var set = Settings.get();
    var canRegister = !!set.allowSelfRegister || !!(set.hook && set.hook.postUrl);

    function draw(mode) {
      view.innerHTML = '';
      var card = U.el('div.card', { style: { maxWidth: '440px', margin: '26px auto' } });

      var tabs = U.el('div.row', { style: { gap: '6px', marginBottom: '14px' } }, [
        U.el('button.btn.sm' + (mode === 'login' ? '.primary' : ''), {
          text: '登入', onclick: function () { draw('login'); }
        })
      ]);
      if (canRegister) {
        tabs.appendChild(U.el('button.btn.sm' + (mode === 'reg' ? '.primary' : ''), {
          text: '第一次使用・註冊', onclick: function () { draw('reg'); }
        }));
      }
      card.appendChild(tabs);

      if (mode === 'login') {
        card.appendChild(U.el('h2', { text: '學生登入' }));
        card.appendChild(U.el('p.tiny.muted', {
          text: '用手機、iPad 或電腦都可以登入；作答進度會自動存到雲端，換裝置也能繼續。'
        }));
        var un = U.el('input.input', { placeholder: '使用者帳號' });
        var pw = U.el('input.input', { type: 'password', placeholder: '密碼' });
        card.appendChild(field('帳號', un));
        card.appendChild(U.el('div', { style: { height: '8px' } }));
        card.appendChild(field('密碼', pw));
        var btn = U.el('button.btn.primary.block.mt2', {
          text: '登入', onclick: function () { doLogin(U.trim(un.value), pw.value); }
        });
        card.appendChild(btn);
        pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(U.trim(un.value), pw.value); });
        view.appendChild(card);
        un.focus();
        return;
      }

      /* ---- 註冊 ---- */
      card.appendChild(U.el('h2', { text: '註冊帳號' }));
      if (!set.allowSelfRegister) {
        card.appendChild(U.el('div.warnbox', {
          text: '老師尚未開啟自助註冊。若你已有老師給的帳號，請改用「登入」。'
        }));
        view.appendChild(card);
        return;
      }
      var rName = U.el('input.input', { placeholder: '例如：陳小明' });
      var rClass = U.el('input.input', { placeholder: '例如：2A（可留空）' });
      var rUser = U.el('input.input', { placeholder: '英文或數字，例如 ming123' });
      var rPw = U.el('input.input', { type: 'password', placeholder: '至少 4 個字' });
      var rCode = U.el('input.input', { placeholder: '向老師索取' });
      card.appendChild(field('姓名', rName));
      card.appendChild(field('班別（選填）', rClass));
      card.appendChild(field('自選帳號', rUser));
      card.appendChild(field('自訂密碼', rPw));
      card.appendChild(field('班級代碼', rCode));
      card.appendChild(U.el('button.btn.primary.block.mt2', {
        text: '註冊並登入', onclick: function () { doRegister(); }
      }));
      view.appendChild(card);

      function doRegister() {
        var u = U.trim(rUser.value), p = U.trim(rPw.value), n = U.trim(rName.value);
        if (!u || !p || !n) { U.toast('姓名、帳號、密碼都要填', 'bad'); return; }
        if (p.length < 4) { U.toast('密碼至少 4 個字', 'bad'); return; }
        if (/\s/.test(u)) { U.toast('帳號不能有空格', 'bad'); return; }
        Backend.getRoster().then(function (list) {
          if (list.some(function (s) { return String(s.username).toLowerCase() === u.toLowerCase(); })) {
            U.toast('這個帳號已經有人用了，換一個試試', 'bad');
            return null;
          }
          return RQ.crypto.hashPassword(p).then(function (h) {
            var stu = {
              id: U.uid('stu'), username: u, name: n,
              className: U.trim(rClass.value), pass: h,
              classCode: U.trim(rCode.value),
              createdAt: U.nowISO(), selfRegistered: true
            };
            return Backend.registerStudent(stu).then(function () { return stu; });
          });
        }).then(function (stu) {
          if (!stu) return;
          Settings.login({ role: 'student', id: stu.id, name: stu.name, username: stu.username });
          U.toast('註冊成功，歡迎 ' + stu.name, 'ok');
          location.hash = '#/student';
        }).catch(function (e) { U.toast('註冊失敗：' + e.message, 'bad'); });
      }
    }

    function field(label, input) {
      var d = U.el('div');
      d.appendChild(U.el('label.tiny.muted', { text: label }));
      d.appendChild(input);
      return d;
    }

    function doLogin(name, pass) {
      if (!name || !pass) { U.toast('請輸入帳號與密碼', 'bad'); return; }
      U.toast('驗證中…', null, 1200);
      Backend.getRoster().then(function (list) {
        var stu = list.filter(function (s) {
          return String(s.username).toLowerCase() === String(name).toLowerCase();
        })[0];
        if (!stu) { U.toast('找不到此帳號，請確認或改用註冊', 'bad', 3000); return; }
        return RQ.crypto.verifyPassword(pass, stu.pass).then(function (ok) {
          if (!ok) { U.toast('密碼不正確', 'bad'); return; }
          Settings.login({ role: 'student', id: stu.id, name: stu.name || stu.username, username: stu.username });
          U.toast('歡迎，' + (stu.name || stu.username), 'ok');
          location.hash = '#/student';
        });
      }).catch(function (e) { U.toast('登入失敗：' + e.message, 'bad'); });
    }

    draw('login');
  };

  Student.home = function (view) {
    var who = Settings.who();
    view.innerHTML = '';

    view.appendChild(U.el('div.hero.mb0', {}, [
      U.el('h1', { text: '哈囉，' + (who.name || '同學') }),
      U.el('p', { html: '下方是你可以使用的閱讀理解試卷。作答時可以直接在文章上<b>畫重點、寫筆記、把不會的詞語收進生詞本</b>，老師會看得到。' })
    ]));

    var box = U.el('div.mt3');
    view.appendChild(box);

    Promise.all([
      Backend.listQuizzes(),
      Store.submission.ofStudent(who.id)
    ]).then(function (r) {
      var quizzes = r[0].filter(function (q) { return q.published !== false || q._src === 'local'; });
      var mine = r[1] || [];
      box.innerHTML = '';

      if (!quizzes.length) {
        box.appendChild(U.el('div.empty', {}, [
          U.el('div.big', { text: '📚' }),
          U.el('div', { text: '目前還沒有試卷' }),
          U.el('small', { text: '請老師先上傳並發佈試卷' })
        ]));
        return;
      }

      var grid = U.el('div.grid.g2');
      quizzes.forEach(function (m) {
        var done = mine.filter(function (s) { return s.quizId === m.id; });
        var card = U.el('div.card.mb0');
        card.appendChild(U.el('div.row.between', {}, [
          U.el('h3.mb0', { html: U.esc(m.title) }),
          done.length ? U.el('span.tag.mint', { text: '已完成 ' + done.length + ' 次' }) : U.el('span.tag', { text: '未作答' })
        ]));
        card.appendChild(U.el('div.tiny.muted.mt1', {
          text: (m.level ? m.level + '・' : '') + (m.questionCount || 0) + ' 題・' + (m.totalMarks || 0) + ' 分'
        }));
        if (done.length) {
          var last = done[0];
          card.appendChild(U.el('div.tiny.mt1', {
            html: '上次得分：<b>' + (last.score ? last.score.total : 0) + '</b> / ' + (last.score ? last.score.max : 0) +
              '　（' + U.fmtDate(last.submittedAt, true) + '）'
          }));
        }
        var btns = U.el('div.row.mt2', {}, [
          U.el('a.btn.primary.sm', { href: '#/quiz/' + m.id, text: done.length ? '再作答一次' : '開始作答' })
        ]);
        if (done.length) {
          btns.appendChild(U.el('a.btn.sm', { href: '#/result/' + done[0].id, text: '查看上次結果' }));
        }
        card.appendChild(btns);
        grid.appendChild(card);
      });
      box.appendChild(grid);

      /* 生詞本 */
      box.appendChild(U.el('h2.mt3', { text: '我的生詞本' }));
      box.appendChild(vocabBook(mine));
    });
  };

  function vocabBook(subs) {
    var map = {};
    (subs || []).forEach(function (s) {
      (s.vocab || []).forEach(function (v) { map[v.word] = v; });
    });
    var words = Object.keys(map);
    if (!words.length) {
      return U.el('div.empty', {}, [
        U.el('div.big', { text: '🔖' }),
        U.el('small', { text: '還沒有收集生詞。作答時選取不懂的詞語，按「加入生詞本」即可。' })
      ]);
    }
    var wrap = U.el('div.card');
    words.forEach(function (w) {
      var v = map[w];
      var row = U.el('div.row.between', { style: { borderBottom: '1px dashed var(--line)', padding: '6px 0' } }, [
        U.el('b', { text: w }),
        U.el('span.tiny.muted', { text: v.note || '' })
      ]);
      wrap.appendChild(row);
    });
    return wrap;
  }

  /* ============================================================
     作答頁
     ============================================================ */
  var _session = null;         // {quiz, submission, hls:[], startAt}
  var _unloadHandler = null;   // 離開頁面前把雲端草稿補送出去

  Student.take = function (view, quizId) {
    view.innerHTML = '<div class="empty">載入試卷中…</div>';
    var who = Settings.who();

    Promise.all([
      Backend.getQuiz(quizId),
      Store.submission.ofStudent(who.id)
    ]).then(function (r) {
      var quiz = r[0];
      if (!quiz) { view.innerHTML = '<div class="empty">找不到這份試卷</div>'; return; }
      var past = (r[1] || []).filter(function (s) { return s.quizId === quizId; });
      if (past.length && !Settings.get().allowRetake) {
        view.innerHTML = '';
        view.appendChild(U.el('div.card.center', {}, [
          U.el('h2', { text: '你已經作答過這份試卷' }),
          U.el('p.muted', { text: '如需重做，請先請老師開啟「允許重複作答」。' }),
          U.el('div.row', { style: { justifyContent: 'center' } }, [
            U.el('a.btn.primary', { href: '#/result/' + past[0].id, text: '查看結果' }),
            U.el('a.btn', { href: '#/student', text: '回學生專區' })
          ])
        ]));
        return;
      }
      startQuiz(view, quiz, who, past.length + 1);
    });
  };

  function startQuiz(view, quiz, who, attempt) {
    var sub = {
      id: U.uid('sub'),
      quizId: quiz.id,
      quizTitle: quiz.title,
      studentId: who.id,
      studentName: who.name,
      username: who.username,
      attempt: attempt,
      startedAt: U.nowISO(),
      submittedAt: null,
      answers: {},
      marks: [],
      vocab: [],
      notes: [],
      score: null
    };
    _session = { quiz: quiz, sub: sub, hls: [], startAt: Date.now(), view: view };

    view.innerHTML = '';

    /* 頂端列 */
    var bar = U.el('div.card.tinted', {});
    var timerEl = U.el('b', { text: '00:00' });
    bar.appendChild(U.el('div.row.between', {}, [
      U.el('div', {}, [
        U.el('h2.mb0', { html: U.esc(quiz.title) }),
        U.el('div.tiny.muted', { text: (quiz.level ? quiz.level + '・' : '') + (quiz.questions || []).length + ' 題・共 ' + quiz.totalMarks + ' 分' })
      ]),
      U.el('div.row', {}, [
        U.el('span.tiny.muted', { text: '已用時間 ' }), timerEl,
        U.el('span', { style: { width: '10px' } }), saveState
      ])
    ]));
    var prog = U.el('div.bar.mt1');
    var progFill = U.el('i', { style: { width: '0%' } });
    prog.appendChild(progFill);
    bar.appendChild(prog);
    var progTxt = U.el('div.tiny.faint', { text: '作答進度 0 / ' + (quiz.questions || []).length });
    bar.appendChild(progTxt);
    view.appendChild(bar);

    var timer = setInterval(function () {
      var s = Math.floor((Date.now() - _session.startAt) / 1000);
      timerEl.textContent = Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }, 1000);
    _session.timer = timer;

    /* 主體：左文章、右題目 */
    var grid = U.el('div.grid', { style: { gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)' } });
    if (window.innerWidth < 900) grid.style.gridTemplateColumns = '1fr';

    var left = U.el('div');
    (quiz.passages || []).forEach(function (p) {
      var card = U.el('div.card.mb0', { style: { marginBottom: '14px' } });
      var holder = U.el('div.passage');
      card.appendChild(holder);
      var hl = new RQ.Highlighter({
        container: holder,
        passage: p,
        marks: sub.marks,
        vocab: sub.vocab,
        onChange: function (marks, vocab) { sub.marks = marks; sub.vocab = vocab; autosave(); }
      });
      _session.hls.push(hl);

      var noteBox = U.el('div.mt2');
      noteBox.appendChild(U.el('label.tiny.muted', { text: '這一篇文章的整體筆記' }));
      var nt = U.el('textarea.input', { rows: 2, placeholder: '例如：主旨是…' });
      nt.addEventListener('input', U.debounce(function () {
        sub.notes = sub.notes.filter(function (n) { return n.pid !== p.id; });
        if (U.trim(nt.value)) sub.notes.push({ id: U.uid('nt'), pid: p.id, text: U.trim(nt.value), ts: U.nowISO() });
        autosave();
      }, 400));
      noteBox.appendChild(nt);
      card.appendChild(noteBox);
      left.appendChild(card);
    });
    grid.appendChild(left);

    var right = U.el('div');
    right.appendChild(U.el('h3', { text: '題目' }));
    (quiz.questions || []).forEach(function (q, i) {
      right.appendChild(questionCard(quiz, q, i, sub, autosave, updateProgress));
    });

    var submitRow = U.el('div.card.center.mt2', {}, [
      U.el('div.tiny.muted', { text: '提交後即可看到正確答案；老師會收到你的作答、標記與生詞。' }),
      U.el('div.row.mt2', { style: { justifyContent: 'center' } }, [
        U.el('button.btn.primary', {
          text: '提交作答', onclick: function () { submit(quiz, sub, view); }
        })
      ])
    ]);
    right.appendChild(submitRow);
    grid.appendChild(right);
    view.appendChild(grid);

    var saveState = U.el('span.tiny.faint', { text: '' });
    var _lastCloud = 0;

    function autosave(force) {
      sub.durationSec = Math.floor((Date.now() - _session.startAt) / 1000);
      sub.savedAt = U.nowISO();
      /* ① 本機：每次變動都存，離線也安全 */
      Store.kv.set('draft:' + sub.quizId + ':' + sub.studentId, sub);
      /* ② 雲端：節流（每 20 秒或強制），換裝置才能繼續 */
      var now = Date.now();
      if (Settings.get().cloudDraft !== false && (force || now - _lastCloud > 20000)) {
        _lastCloud = now;
        saveState.textContent = '儲存中…';
        Backend.saveDraft(sub).then(function () {
          saveState.textContent = '進度已儲存 ' + U.fmtDate(U.nowISO(), true).slice(11);
        }).catch(function () {
          saveState.textContent = '（雲端儲存失敗，進度已存在本機）';
        });
      } else {
        saveState.textContent = '進度已存在本機';
      }
      updateProgress();
    }
    function updateProgress() {
      var total = (quiz.questions || []).length;
      var done = quiz.questions.filter(function (q) {
        var a = sub.answers[q.id];
        if (!a) return false;
        if (q.type === 'mcq') return (a.value || []).length > 0;
        if (q.type === 'table' && (q.subQuestions || []).length) {
          return Object.keys(a.sub || {}).some(function (k) { return U.trim(a.sub[k]); });
        }
        return U.trim(a.value || '') !== '';
      }).length;
      progFill.style.width = Math.round(done / total * 100) + '%';
      progTxt.textContent = '作答進度 ' + done + ' / ' + total;
    }
    _session.autosave = autosave;

    /* 還原草稿：自動接續，不再問「要不要繼續」 */
    Backend.getDraft(quiz.id, sub.studentId).then(function (d) {
      updateProgress();
      if (!d) return;
      var hasContent = Object.keys(d.answers || {}).length ||
        (d.marks || []).length || (d.vocab || []).length;
      if (!hasContent) return;

      sub.answers = d.answers || {};
      sub.marks = d.marks || [];
      sub.vocab = d.vocab || [];
      sub.notes = d.notes || [];

      _session.hls.forEach(function (h) { h.marks = sub.marks; h.vocab = sub.vocab; h.render(); });
      U.$$('[data-qid]', view).forEach(function (card) {
        var qid = card.getAttribute('data-qid');
        var q = (quiz.questions || []).filter(function (x) { return x.id === qid; })[0];
        if (!q) return;
        var holder = card.querySelector('.q-input');
        if (!holder) return;
        holder.innerHTML = '';
        holder.appendChild(Forms.input(q, sub.answers[qid], {
          uid: sub.id,
          onChange: function (v) { sub.answers[qid] = Object.assign({}, sub.answers[qid], v); autosave(); }
        }));
      });
      updateProgress();

      var n = Object.keys(sub.answers).length;
      U.toast('已接續上次的進度（' + n + ' 題已作答' + (sub.marks.length ? '、' + sub.marks.length + ' 處標記' : '') + '）', 'ok', 3600);
    });

    /* 離開頁面前強制存一次（sendBeacon 在關閉分頁時仍會送出） */
    if (_unloadHandler) window.removeEventListener('beforeunload', _unloadHandler);
    _unloadHandler = function () {
      try {
        sub.durationSec = Math.floor((Date.now() - _session.startAt) / 1000);
        sub.savedAt = U.nowISO();
        Store.kv.set('draft:' + sub.quizId + ':' + sub.studentId, sub);
        if (Settings.get().cloudDraft === false) return;
        var driver = Backend.Cloud.driver();
        if (driver === 'firebase' && Backend.Firebase.ok()) {
          var st = Settings.get().fb;
          var body = JSON.stringify({
            type: 'draft',
            id: ('draft::' + sub.quizId + '::' + sub.studentId).replace(/[.#$\/\[\]?:]/g, '_'),
            quizId: sub.quizId, studentId: sub.studentId, studentName: sub.studentName || '',
            ts: U.nowISO(), key: '', payload: sub
          });
          var u = String(st.dbUrl).replace(/\/+$/, '') + '/rq/' +
            encodeURIComponent(String(st.classCode || 'default').replace(/[.#$\/\[\]?:]/g, '_')) +
            '/draft/' + encodeURIComponent(('draft::' + sub.quizId + '::' + sub.studentId).replace(/[.#$\/\[\]?:]/g, '_')) +
            '.json?auth=' + encodeURIComponent(st._token || '');
          navigator.sendBeacon && navigator.sendBeacon(u, new Blob([body], { type: 'text/plain' }));
        } else if (driver === 'appscript') {
          var url = Settings.get().hook.postUrl;
          var b2 = JSON.stringify({
            type: 'draft', id: 'draft::' + sub.quizId + '::' + sub.studentId,
            quizId: sub.quizId, studentId: sub.studentId, studentName: sub.studentName || '',
            ts: U.nowISO(), key: (Settings.get().hook || {}).key || '', payload: sub
          });
          navigator.sendBeacon && navigator.sendBeacon(url, new Blob([b2], { type: 'text/plain' }));
        }
      } catch (e) { /* 關閉分頁時盡力而為 */ }
    };
    window.addEventListener('beforeunload', _unloadHandler);
  }

  function questionCard(quiz, q, idx, sub, autosave, updateProgress) {
    var card = U.el('div.q', { dataset: { qid: q.id } });
    var head = U.el('div.q-head');
    head.appendChild(U.el('div.q-no', { text: String(q.no != null ? q.no : idx + 1) }));
    var stem = U.el('div.q-stem');
    stem.appendChild(U.el('div', { html: U.esc(q.stem) }));
    var meta = U.el('div.q-meta');
    if (q.marks) meta.appendChild(U.el('span.tag.sun', { text: q.marks + ' 分' }));
    (q.skills || []).forEach(function (s) { meta.appendChild(U.el('span.tag.lav', { text: s, style: { marginLeft: '4px' } })); });
    if (q.type === 'mcq') meta.appendChild(U.el('span.tag.sky', { text: '選擇題', style: { marginLeft: '4px' } }));
    if (q.type === 'table') meta.appendChild(U.el('span.tag.gray', { text: '填充／表格題', style: { marginLeft: '4px' } }));
    stem.appendChild(meta);
    head.appendChild(stem);
    card.appendChild(head);

    var holder = U.el('div.q-input');
    holder.appendChild(Forms.input(q, sub.answers[q.id], {
      uid: sub.id,
      onChange: function (v) {
        sub.answers[q.id] = Object.assign({}, sub.answers[q.id], v);
        autosave(); updateProgress();
      }
    }));
    card.appendChild(holder);
    return card;
  }

  function submit(quiz, sub, view) {
    var total = (quiz.questions || []).length;
    var answered = quiz.questions.filter(function (q) {
      var a = sub.answers[q.id];
      if (!a) return false;
      if (q.type === 'mcq') return (a.value || []).length > 0;
      if (q.type === 'table' && (q.subQuestions || []).length) {
        return Object.keys(a.sub || {}).some(function (k) { return U.trim(a.sub[k]); });
      }
      return U.trim(a.value || '') !== '';
    }).length;

    U.modal({
      title: '確定提交？',
      body: '<p>已作答 <b>' + answered + '</b> / ' + total + ' 題。</p>' +
        (answered < total ? '<p class="warnbox">還有 ' + (total - answered) + ' 題未作答，提交後就不能再修改囉。</p>' : ''),
      actions: [
        { label: '再檢查一下' },
        {
          label: '確定提交', kind: 'primary', onClick: function () {
            doSubmit(quiz, sub, view);
          }
        }
      ]
    });
  }

  function doSubmit(quiz, sub, view) {
    if (_session.timer) clearInterval(_session.timer);

    var auto = 0, autoMax = 0;
    quiz.questions.forEach(function (q) {
      var got = Forms.autoScore(q, sub.answers[q.id]);
      if (got !== null) { auto += got; autoMax += (q.marks || 0); }
    });
    sub.submittedAt = U.nowISO();
    sub.durationSec = Math.floor((Date.now() - _session.startAt) / 1000);
    sub.score = {
      auto: auto, autoMax: autoMax,
      manual: 0, total: auto, max: quiz.totalMarks || 0,
      graded: false
    };

    Backend.saveSubmission(sub).then(function (saved) {
      Store.kv.set('draft:' + sub.quizId + ':' + sub.studentId, null);
      U.toast('已提交，感謝作答！', 'ok');
      location.hash = '#/result/' + saved.id;
    }).catch(function (e) {
      U.toast('提交失敗：' + e.message, 'bad');
    });
  }

  /* ============================================================
     結果頁
     ============================================================ */
  Student.result = function (view, subId) {
    view.innerHTML = '<div class="empty">載入中…</div>';
    Store.submission.get(subId).then(function (sub) {
      if (!sub) { view.innerHTML = '<div class="empty">找不到這份作答</div>'; return; }
      return Backend.getQuiz(sub.quizId).then(function (quiz) { renderResult(view, sub, quiz); });
    });
  };

  function renderResult(view, sub, quiz) {
    view.innerHTML = '';
    var s = sub.score || { total: 0, max: 0 };
    var pct = U.percent(s.total, s.max);

    var card = U.el('div.score-card');
    card.appendChild(U.el('h2.mb0', { html: U.esc(quiz.title) }));
    card.appendChild(U.el('div.score-num.mt1', {
      html: (s.total || 0) + '<small> / ' + (s.max || 0) + ' 分</small>'
    }));
    card.appendChild(U.el('div.bar.' + U.barClass(pct), {}, [U.el('i', { style: { width: pct + '%' } })]));
    card.appendChild(U.el('div.tiny.muted', {
      html: '正確率 <b>' + pct + '%</b>　用時 ' + U.fmtDur(sub.durationSec) +
        '　提交於 ' + U.fmtDate(sub.submittedAt, true)
    }));
    if (!s.graded) {
      card.appendChild(U.el('div.warnbox.mt2', {
        text: '選擇題已自動計分；文字題尚待老師批閱，分數會再更新。'
      }));
    }
    view.appendChild(card);

    var row = U.el('div.row.mt2', {}, [
      U.el('a.btn', { href: '#/student', text: '回學生專區' })
    ]);
    view.appendChild(row);

    /* 逐題檢討 */
    (quiz.questions || []).forEach(function (q, i) {
      var box = U.el('div.q');
      var head = U.el('div.q-head');
      head.appendChild(U.el('div.q-no', { text: String(q.no != null ? q.no : i + 1) }));
      var stem = U.el('div.q-stem');
      stem.appendChild(U.el('div', { html: U.esc(q.stem) }));
      head.appendChild(stem);
      box.appendChild(head);

      var ans = sub.answers[q.id] || {};
      box.appendChild(U.el('div.ansbox.mt1', {}, [
        U.el('span.lbl', { text: '你的作答' }),
        U.el('div', { html: U.nl2br(Forms.answerText(q, ans)) })
      ]));
      box.appendChild(Forms.reveal(q, ans));
      if (ans.manualScore != null) {
        box.appendChild(U.el('div.mt1', {}, [
          U.el('span.tag.mint', { text: '老師批閱：' + ans.manualScore + ' 分' })
        ]));
        if (ans.teacherComment) {
          box.appendChild(U.el('div.tiny.muted.mt1', { html: '老師評語：' + U.nl2br(ans.teacherComment) }));
        }
      }
      view.appendChild(box);
    });

    /* 我的標記回顧 */
    if ((sub.marks || []).length || (sub.vocab || []).length) {
      var mcard = U.el('div.card.mt3');
      mcard.appendChild(U.el('h3', { text: '我在文章上做的標記' }));
      (sub.marks || []).forEach(function (m) {
        mcard.appendChild(U.el('div.row', { style: { gap: '8px', padding: '4px 0' } }, [
          U.el('span.hl.' + m.color, { text: m.text, style: { padding: '2px 8px', borderRadius: '6px' } }),
          U.el('span.tiny.muted', { text: m.note || '' })
        ]));
      });
      if ((sub.vocab || []).length) {
        mcard.appendChild(U.el('div.mt2', {}, [
          U.el('b.tiny', { text: '生詞本：' + sub.vocab.map(function (v) { return v.word; }).join('、') })
        ]));
      }
      view.appendChild(mcard);
    }
  }

  RQ.student = Student;
})(window.RQ);
