/* ============================================================
   teacher.js — 老師端：上傳 .docx、微調欄位、發佈、查看學生作答
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Store = RQ.store, Settings = RQ.settings, Backend = RQ.backend;
  var TABS = [
    { id: 'upload', label: '① 上傳試卷' },
    { id: 'quizzes', label: '② 試卷管理' },
    { id: 'reports', label: '③ 學生作答' },
    { id: 'roster', label: '④ 學生名冊' },
    { id: 'data', label: '⑤ 資料與同步' }
  ];

  var Teacher = {};
  var state = { tab: 'upload', quizId: null };

  /* ---------- 年級分類（中一～中六） ---------- */
  var GRADES = ['中一', '中二', '中三', '中四', '中五', '中六'];
  function gradeSelect(value, attrs) {
    var sel = U.el('select.input', attrs || {});
    sel.appendChild(U.el('option', { value: '', text: '（未分類）' }));
    GRADES.forEach(function (g) { sel.appendChild(U.el('option', { value: g, text: g })); });
    sel.value = value || '';
    return sel;
  }

  /* 某份作業是否指派給某學生 */
  function assignedTo(meta, studentId) {
    var a = meta && meta.assignment;
    if (!a) return false;
    if (a.all) return true;
    return (a.ids || []).indexOf(studentId) >= 0;
  }

  /* 讀圖檔 → dataURL（順便縮圖，避免儲存過大） */
  function imageToDataURL(file, maxW) {
    maxW = maxW || 1200;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var raw = reader.result;
        try {
          var img = new Image();
          img.onload = function () {
            try {
              var scale = Math.min(1, maxW / (img.width || maxW));
              var c = document.createElement('canvas');
              c.width = Math.max(1, Math.round((img.width || maxW) * scale));
              c.height = Math.max(1, Math.round((img.height || maxW) * scale));
              c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
              resolve(c.toDataURL('image/jpeg', 0.82));
            } catch (e) { resolve(raw); }
          };
          img.onerror = function () { resolve(raw); };
          img.src = raw;
        } catch (e) { resolve(raw); }
      };
      reader.onerror = function () { reject(new Error('讀取圖片失敗')); };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- 指派作業 ---------- */
  function assignDialog(quiz, onSaved) {
    Backend.getRoster().then(function (list) {
      list = list || [];
      var a = quiz.assignment || {};
      var allChk = U.el('input', { type: 'checkbox' });
      allChk.checked = !!a.all;
      var dueInp = U.el('input.input', { type: 'date' });
      dueInp.value = a.due ? String(a.due).slice(0, 10) : '';
      var noteInp = U.el('input.input', { placeholder: '例如：下週一前完成', value: a.note || '' });

      var body = U.el('div');
      body.appendChild(U.el('label.opt', {}, [allChk, U.el('span', { text: ' 指派給全班' })]));
      var stud = U.el('div.mt2', {
        style: { maxHeight: '220px', overflow: 'auto', border: '1.5px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '8px' }
      });
      var rows = [];
      if (!list.length) {
        stud.appendChild(U.el('div.tiny.muted', { text: '名冊尚無學生。學生可自行註冊，或到「④ 學生名冊」新增。' }));
      } else {
        list.forEach(function (s) {
          var chk = U.el('input', { type: 'checkbox' });
          chk.checked = (a.ids || []).indexOf(s.id) >= 0;
          rows.push({ id: s.id, chk: chk });
          stud.appendChild(U.el('label.opt', { style: { marginTop: '4px' } }, [
            chk, U.el('span', { text: ' ' + (s.name || s.username) + (s.className ? '（' + s.className + '）' : '') })
          ]));
        });
      }
      body.appendChild(U.el('div.tiny.muted.mt2', { text: '選擇學生（可多選）' }));
      body.appendChild(stud);
      body.appendChild(U.el('div.mt2', {}, [U.el('label.tiny.muted', { text: '截止日期（選填）' }), dueInp]));
      body.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '備註（選填）' }), noteInp]));

      U.modal({
        title: '指派作業：' + quiz.title,
        width: 560,
        body: body,
        actions: [
          { label: '取消', close: true },
          {
            label: '清除指派', onClick: function () {
              quiz.assignment = null;
              quiz.updatedAt = U.nowISO();
              Store.quiz.save(quiz).then(function () { U.toast('已清除指派'); onSaved && onSaved(); });
            }
          },
          {
            label: '儲存', kind: 'primary', onClick: function () {
              var ids = rows.filter(function (r) { return r.chk.checked; }).map(function (r) { return r.id; });
              if (!allChk.checked && !ids.length) { U.toast('請選「全班」或至少一位學生', 'bad'); return false; }
              quiz.assignment = {
                all: allChk.checked, ids: ids,
                due: dueInp.value || '', note: U.trim(noteInp.value),
                assignedAt: U.nowISO()
              };
              quiz.updatedAt = U.nowISO();
              Store.quiz.save(quiz).then(function () { U.toast('已指派作業', 'ok'); onSaved && onSaved(); });
            }
          }
        ]
      });
    }).catch(function (e) { U.toast('讀取名冊失敗：' + ((e && e.message) || ''), 'bad'); });
  }

  /* ============================================================
     入口
     ============================================================ */
  Teacher.render = function (view, tab) {
    var who = Settings.who();
    if (!who || who.role !== 'teacher') { Teacher.login(view); return; }
    state.tab = tab || state.tab || 'upload';
    view.innerHTML = '';

    var tabs = U.el('div.row', { style: { gap: '6px', marginBottom: '16px', flexWrap: 'wrap' } });
    TABS.forEach(function (t) {
      tabs.appendChild(U.el('button.btn.sm' + (state.tab === t.id ? '.primary' : ''), {
        text: t.label,
        onclick: function () { location.hash = '#/teacher/' + t.id; }
      }));
    });
    view.appendChild(tabs);

    var body = U.el('div');
    view.appendChild(body);
    Teacher[state.tab] && Teacher[state.tab](body);
  };

  Teacher.login = function (view) {
    view.innerHTML = '';
    var set = Settings.get();
    var card = U.el('div.card', { style: { maxWidth: '440px', margin: '30px auto' } });
    card.appendChild(U.el('h2', { text: '老師登入' }));

    if (!set.teacherPass) {
      card.appendChild(U.el('div.infobox', {
        html: '尚未設定老師密碼。請先設定一組密碼（只存在這台電腦的瀏覽器裡）。'
      }));
      var p1 = U.el('input.input', { type: 'password', placeholder: '設定老師密碼' });
      card.appendChild(p1);
      card.appendChild(U.el('div.mt2', {}, [
        U.el('button.btn.primary', {
          text: '設定並登入', onclick: function () {
            var v = U.trim(p1.value);
            if (v.length < 4) { U.toast('密碼至少 4 個字', 'bad'); return; }
            RQ.crypto.hashPassword(v).then(function (h) {
              Settings.set({ teacherPass: h });
              Settings.login({ role: 'teacher', name: '老師' });
              U.toast('已設定，歡迎使用', 'ok');
              location.hash = '#/teacher/upload';
            });
          }
        })
      ]));
    } else {
      var pw = U.el('input.input', { type: 'password', placeholder: '老師密碼' });
      card.appendChild(pw);
      card.appendChild(U.el('div.mt2.row', {}, [
        U.el('button.btn.primary', {
          text: '登入', onclick: function () {
            RQ.crypto.verifyPassword(pw.value, set.teacherPass).then(function (ok) {
              if (!ok) { U.toast('密碼不正確', 'bad'); return; }
              Settings.login({ role: 'teacher', name: '老師' });
              location.hash = '#/teacher/upload';
            });
          }
        }),
        U.el('button.btn.sm.ghost', {
          text: '忘記密碼（重設）', onclick: function () {
            U.confirm('重設會清除這台電腦的老師密碼（試卷與作答不會受影響），確定嗎？', function () {
              Settings.set({ teacherPass: '' });
              location.hash = '#/teacher';
              setTimeout(function () { location.reload(); }, 200);
            });
          }
        })
      ]));
      pw.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') U.$('.btn.primary', card).click();
      });
    }
    view.appendChild(card);
  };

  /* ============================================================
     ① 上傳試卷
     ============================================================ */
  Teacher.upload = function (view) {
    var card = U.el('div.card');
    card.appendChild(U.el('h2', { text: '上傳 Word 試卷（.docx）' }));
    card.appendChild(U.el('p.tiny.muted', {
      html: '程式會在<b>你的瀏覽器裡</b>直接解讀 .docx，自動拆成「文章／題目／選項／答案與解析」。<br>' +
        '若 Word 檔同時含「學生版＋教師版」（如啟思試卷），答案會自動帶入；也可以分開上傳兩個檔。'
    }));

    var opt = { answerColor: 'FF0000', studentFile: null, teacherFile: null };

    /* 進階選項 */
    var adv = U.el('div.row.mt2', {});
    adv.appendChild(U.el('label.tiny.muted', { text: '答案標記顏色：' }));
    var colorInp = U.el('input.input', { value: 'FF0000', style: { width: '110px', flex: '0 0 auto' } });
    colorInp.addEventListener('change', function () { opt.answerColor = U.trim(colorInp.value) || 'FF0000'; });
    adv.appendChild(colorInp);
    adv.appendChild(U.el('span.tiny.faint', { text: '（教師版答案文字的顏色，預設紅色 FF0000）' }));
    card.appendChild(adv);

    /* 年級分類 */
    var gradeRow = U.el('div.row.mt2', {});
    gradeRow.appendChild(U.el('label.tiny.muted', { text: '年級分類：' }));
    var gSel = gradeSelect('', { style: { maxWidth: '150px', flex: '0 0 auto' } });
    gSel.addEventListener('change', function () { opt.level = gSel.value; });
    gradeRow.appendChild(gSel);
    gradeRow.appendChild(U.el('span.tiny.faint', { text: '（上傳後仍可修改；學生首頁會依年級分組）' }));
    card.appendChild(gradeRow);

    /* 發佈選項 */
    var pubChk = U.el('input', { type: 'checkbox' });
    pubChk.checked = true;
    card.appendChild(U.el('div.mt2', {}, [
      U.el('label.check', { style: { display: 'flex' } }, [
        pubChk,
        U.el('span', { text: '解析後直接發佈，讓學生立刻看到（需先在「⑤ 資料與同步」設定 GitHub 或 Firebase）' })
      ])
    ]));

    /* 學生卷 */
    var dropS = dropZone('學生卷（題目卷）', function (f) {
      opt.studentFile = f;
      U.$('.drop-name', dropS).textContent = f.name;
    });
    card.appendChild(U.el('label.tiny.muted.mt2', { text: '學生卷' }));
    card.appendChild(dropS);

    /* 教師卷 */
    var dropT = dropZone('教師卷／答案卷（可留空：若學生卷已內含教師版）', function (f) {
      opt.teacherFile = f;
      U.$('.drop-name', dropT).textContent = f.name;
    });
    card.appendChild(U.el('label.tiny.muted.mt2', { text: '教師卷（選填）' }));
    card.appendChild(dropT);

    var btnRow = U.el('div.row.mt2', {}, [
      U.el('button.btn.primary', {
        text: '開始解析', onclick: function () {
          if (!opt.studentFile) { U.toast('請先選擇學生卷', 'bad'); return; }
          opt.autoPublish = false;
          runParse(view, opt);
        }
      }),
      U.el('button.btn.mint', {
        text: '解析並發佈', onclick: function () {
          if (!opt.studentFile) { U.toast('請先選擇學生卷', 'bad'); return; }
          opt.autoPublish = true;
          runParse(view, opt);
        }
      })
    ]);
    card.appendChild(btnRow);
    view.appendChild(card);

    /* 解析規則說明 */
    view.appendChild(U.el('div.card.tinted', {}, [
      U.el('h3', { text: '解析規則（給會想微調的人看）' }),
      U.el('div.tiny', {
        html: [
          '<b>R1</b>　.docx 其實是 zip，讀取 word/document.xml 後依文件順序還原段落與表格。',
          '<b>R2</b>　教師版答案用紅色標記（<code>&lt;w:color w:val="FF0000"/&gt;</code>）→ 紅字即答案。',
          '<b>R3</b>　選擇題選項前是 Wingdings 符號：Wingdings F081→A、F082→B…；Wingdings 2 F06A→A、F06B→B…',
          '<b>R4</b>　題號＝段落以 1～2 位數字開頭，且該行含（n分）或「？」；分數＝題幹內（n分）加總。',
          '<b>R5</b>　文章＝「閱讀能力考材」到「－完－」之間，以「第一篇／第二篇」分段，長度 ≥ 25 字視為正文。',
          '<b>R6</b>　【整合】【引申】等能力標記會從題幹抽出來，另存為標籤。',
          '<b>R7</b>　表格題逐一比對學生版／教師版儲存格，產生子題；教師版有紅色勾選記號者，答案取該欄標題。',
          '<b>R8</b>　「答案分析：」之後的文字視為解析。'
        ].map(function (x) { return '<div style="padding:2px 0">' + x + '</div>'; }).join('')
      })
    ]));
  };

  function dropZone(label, onFile) {
    var z = U.el('div.drop', {}, [
      U.el('div.big', { text: '📄' }),
      U.el('b', { text: label }),
      U.el('small', { text: '點擊選擇，或把 .docx 拖到這裡' }),
      U.el('div.drop-name.tiny', { style: { marginTop: '6px', color: 'var(--pink-deep)' } })
    ]);
    z.addEventListener('click', function () {
      U.pickFile('.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', function (f) {
        if (!/\.docx$/i.test(f.name)) { U.toast('目前只支援 .docx（舊的 .doc 請先另存為 .docx）', 'bad'); return; }
        onFile(f);
      });
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.remove('over'); });
    });
    z.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files[0];
      if (f && /\.docx$/i.test(f.name)) onFile(f);
    });
    return z;
  }

  function runParse(view, opt) {
    var card = U.el('div.card', {}, [
      U.el('div.center', {}, [U.el('b', { text: '解析中…' }), U.el('div.tiny.muted', { text: '視試卷長度約需 1–5 秒' })])
    ]);
    view.appendChild(card);

    var p = opt.teacherFile
      ? RQ.docx.parsePair(opt.studentFile, opt.teacherFile, {
        answerColor: opt.answerColor,
        studentName: opt.studentFile.name, teacherName: opt.teacherFile.name
      })
      : RQ.docx.parse(opt.studentFile, { answerColor: opt.answerColor, fileName: opt.studentFile.name });

    p.then(function (res) {
      var quiz = {
        id: U.slug(res.title) + '-' + Date.now().toString(36).slice(-4),
        title: res.title,
        level: opt.level || res.level || '',
        source: res.source || '',
        createdAt: U.nowISO(),
        updatedAt: U.nowISO(),
        published: false,
        passages: res.passages,
        questions: res.questions,
        totalMarks: res.totalMarks,
        warnings: res.warnings,
        stats: res.stats
      };
      return Store.quiz.save(quiz).then(function () {
        if (!opt.autoPublish) {
          U.toast('解析完成：' + res.questions.length + ' 題／' + res.passages.length + ' 篇文章（已存為草稿，請按「發佈到 GitHub」）', 'ok', 4500);
          location.hash = '#/edit/' + quiz.id;
          return null;
        }
        return Backend.publishQuiz(quiz).then(function () {
          U.toast('解析完成並已發佈！學生重新載入即可看到', 'ok', 4500);
          location.hash = '#/edit/' + quiz.id;
        }).catch(function (e) {
          U.toast('已解析但發佈失敗：' + ((e && e.message) || '') + '（可到編輯頁手動發佈）', 'bad', 6000);
          location.hash = '#/edit/' + quiz.id;
        });
      });
    }).catch(function (e) {
      card.innerHTML = '';
      card.appendChild(U.el('div.warnbox', { text: '解析失敗：' + (e && e.message ? e.message : e) }));
      console.error(e);
    });
  }

  /* ============================================================
     試卷編輯（手動微調）
     ============================================================ */
  Teacher.edit = function (view, quizId) {
    view.innerHTML = '<div class="empty">載入中…</div>';
    Store.quiz.get(quizId).then(function (quiz) {
      if (!quiz) { view.innerHTML = '<div class="empty">找不到這份試卷</div>'; return; }
      renderEditor(view, quiz);
    });
  };

  function renderEditor(view, quiz) {
    view.innerHTML = '';

    /* 頂端：基本資料 + 動作 */
    var top = U.el('div.card');
    var tInp = U.el('input.input', { value: quiz.title || '' });
    var lInp = gradeSelect(quiz.level || '', { style: { maxWidth: '160px' } });
    top.appendChild(U.el('div.row.between', {}, [
      U.el('h2.mb0', { text: '微調試卷內容' }),
      U.el('span.tag' + (quiz.published ? '.mint' : '.gray'), { text: quiz.published ? '已發佈' : '尚未發佈' })
    ]));
    top.appendChild(U.el('div.inline-fields.mt2', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '試卷名稱' }), tInp]),
      U.el('div', { style: { maxWidth: '180px' } }, [U.el('label.tiny.muted', { text: '年級分類' }), lInp])
    ]));

    /* 作業指派狀態 */
    var asg = quiz.assignment;
    var asgLine = U.el('div.tiny.mt1', {
      html: asg
        ? '📌 <b>已指派</b>：' + (asg.all ? '全班' : ((asg.ids || []).length + ' 位學生')) +
          (asg.due ? '　截止 ' + asg.due : '') + (asg.note ? '　' + U.esc(asg.note) : '')
        : '<span class="muted">尚未指派為作業</span>'
    });
    top.appendChild(asgLine);

    /* 發佈狀態提示：草稿學生看不到，要按「發佈到 GitHub」 */
    if (!quiz.published) {
      var hasCloud = (Backend.GitHub && Backend.GitHub.ok && Backend.GitHub.ok()) ||
                     (Backend.Firebase && Backend.Firebase.ok && Backend.Firebase.ok());
      top.appendChild(U.el('div.warnbox.mt2', {
        html: hasCloud
          ? '📄 <b>這份試卷仍是草稿，學生還看不到。</b>確認內容無誤後，按下方「<b>發佈到 GitHub</b>」即可發佈。'
          : '📄 <b>這份試卷仍是草稿，學生還看不到。</b>而且目前<b>尚未設定雲端</b>，請先到「<b>⑤ 資料與同步</b>」填好 GitHub（擁有者／repo／Token）或 Firebase，再回來按「<b>發佈到 GitHub</b>」發佈。'
      }));
    }

    if ((quiz.warnings || []).length) {
      var w = U.el('div.warnbox.mt2');
      w.appendChild(U.el('b', { text: '解析提醒：' }));
      var ul = U.el('ul', { style: { margin: '4px 0 0', paddingLeft: '20px' } });
      quiz.warnings.forEach(function (x) { ul.appendChild(U.el('li', { text: x })); });
      w.appendChild(ul);
      top.appendChild(w);
    }

    var acts = U.el('div.row.mt2', {}, [
      U.el('button.btn.primary', { text: '儲存', onclick: save }),
      U.el('button.btn.mint', { text: '預覽（學生視角）', onclick: preview }),
      U.el('button.btn.lav', { text: '指派作業', onclick: assign }),
      U.el('button.btn.sun', { text: '下載 JSON', onclick: download }),
      U.el('button.btn.lav', { text: '發佈到 GitHub', onclick: publish }),
      U.el('button.btn.danger', { text: '刪除試卷', onclick: remove })
    ]);
    top.appendChild(acts);
    view.appendChild(top);

    /* 文章 */
    var pcard = U.el('div.card');
    pcard.appendChild(U.el('h3', { text: '閱讀文章（' + (quiz.passages || []).length + ' 篇）' }));
    (quiz.passages || []).forEach(function (p, pi) {
      pcard.appendChild(passageEditor(quiz, p, pi, refresh));
    });
    pcard.appendChild(U.el('div.mt2', {}, [
      U.el('button.btn.sm.ghost', {
        text: '＋ 新增一篇文章', onclick: function () {
          quiz.passages.push({ id: 'p' + ((quiz.passages.length) + 1), title: '第 ' + (quiz.passages.length + 1) + ' 篇', paragraphs: [''], notes: [] });
          refresh();
        }
      })
    ]));
    view.appendChild(pcard);

    /* 題目 */
    var qcard = U.el('div.card');
    qcard.appendChild(U.el('div.row.between', {}, [
      U.el('h3.mb0', { text: '題目（' + (quiz.questions || []).length + ' 題，共 ' + (quiz.totalMarks || 0) + ' 分）' }),
      U.el('button.btn.sm.ghost', {
        text: '＋ 新增題目', onclick: function () {
          var no = (quiz.questions.length ? Math.max.apply(null, quiz.questions.map(function (q) { return q.no || 0; })) : 0) + 1;
          quiz.questions.push({
            id: 'q' + no, no: no, stem: '', type: 'text', marks: 0, options: [],
            subQuestions: [], answer: '', answerKeys: [], explanation: '',
            passageId: (quiz.passages[0] || {}).id || null, skills: []
          });
          refresh();
        }
      })
    ]));
    (quiz.questions || []).forEach(function (q, qi) {
      qcard.appendChild(questionEditor(quiz, q, qi, refresh));
    });
    view.appendChild(qcard);

    function refresh() {
      quiz.totalMarks = (quiz.questions || []).reduce(function (a, q) { return a + (parseFloat(q.marks) || 0); }, 0);
      renderEditor(view, quiz);
    }
    function save() {
      quiz.title = U.trim(tInp.value) || quiz.title;
      quiz.level = U.trim(lInp.value);
      quiz.updatedAt = U.nowISO();
      Store.quiz.save(quiz).then(function () { U.toast('已儲存', 'ok'); });
    }
    function assign() {
      quiz.title = U.trim(tInp.value) || quiz.title;
      quiz.level = U.trim(lInp.value);
      assignDialog(quiz, function () { Store.quiz.get(quiz.id).then(function (q) { renderEditor(view, q || quiz); }); });
    }
    function preview() {
      quiz.title = U.trim(tInp.value) || quiz.title;
      U.modal({
        title: '學生視角預覽',
        width: 900,
        body: buildPreview(quiz),
        actions: [{ label: '關閉' }]
      });
    }
    function download() {
      U.download(U.slug(quiz.title) + '.json', JSON.stringify(quiz, null, 2));
    }
    function publish() {
      quiz.title = U.trim(tInp.value) || quiz.title;
      /* 注意：published 只可在「發佈成功」後才設為 true（Backend.publishQuiz 內部會設），
         否則發佈失敗時會被誤標成「已發佈」，之後按儲存就會把假狀態存起來。 */
      Backend.publishQuiz(quiz).then(function () {
        U.toast('已發佈，學生重新載入頁面即可看到', 'ok');
        refresh();
      }).catch(function (e) { U.toast('發佈失敗：' + e.message, 'bad'); });
    }
    function remove() {
      U.confirm('確定刪除這份試卷？學生的作答記錄不會被刪除。', function () {
        Store.quiz.del(quiz.id).then(function () {
          U.toast('已刪除'); location.hash = '#/teacher/quizzes';
        });
      });
    }
  }

  function passageEditor(quiz, p, pi, refresh) {
    var box = U.el('div.subq');
    var t = U.el('input.input', { value: p.title || '' });
    t.addEventListener('input', function () { p.title = t.value; });
    var ta = U.el('textarea.input', { rows: 6 });
    ta.value = (p.paragraphs || []).join('\n');
    ta.addEventListener('input', function () {
      p.paragraphs = ta.value.split('\n').map(function (x) { return U.trim(x); }).filter(function (x) { return x; });
    });
    var nt = U.el('textarea.input', { rows: 2 });
    nt.value = (p.notes || []).join('\n');
    nt.addEventListener('input', function () {
      p.notes = nt.value.split('\n').map(function (x) { return U.trim(x); }).filter(function (x) { return x; });
    });

    box.appendChild(U.el('div.row.between', {}, [
      U.el('div', { style: { flex: '1' } }, [U.el('label.tiny.muted', { text: '標題' }), t]),
      U.el('button.btn.xs.danger', {
        text: '刪除本篇', onclick: function () {
          U.confirm('刪除「' + (p.title || '') + '」？', function () {
            quiz.passages.splice(pi, 1); refresh();
          });
        }
      })
    ]));
    box.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '正文（一行一段落）' }), ta]));
    box.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '注釋（一行一則）' }), nt]));
    return box;
  }

  function questionEditor(quiz, q, qi, refresh) {
    var box = U.el('div.q');
    box.appendChild(U.el('div.row.between', {}, [
      U.el('div.row', {}, [
        U.el('div.q-no', { text: String(q.no != null ? q.no : qi + 1) }),
        (function () {
          var s = U.el('select.input', { style: { maxWidth: '150px' } });
          [['text', '文字題'], ['mcq', '選擇題'], ['table', '填充／表格題']].forEach(function (o) {
            s.appendChild(U.el('option', { value: o[0], text: o[1] }));
          });
          s.value = q.type || 'text';
          s.addEventListener('change', function () { q.type = s.value; refresh(); });
          return s;
        })()
      ]),
      U.el('div.row', {}, [
        U.el('button.btn.xs', { text: '↑', onclick: move(-1) }),
        U.el('button.btn.xs', { text: '↓', onclick: move(1) }),
        U.el('button.btn.xs.danger', {
          text: '刪除', onclick: function () {
            U.confirm('刪除第 ' + q.no + ' 題？', function () { quiz.questions.splice(qi, 1); refresh(); });
          }
        })
      ])
    ]));

    function move(d) {
      return function () {
        var j = qi + d;
        if (j < 0 || j >= quiz.questions.length) return;
        var tmp = quiz.questions[qi]; quiz.questions[qi] = quiz.questions[j]; quiz.questions[j] = tmp;
        refresh();
      };
    }

    /* 題幹 */
    var stem = U.el('textarea.input', { rows: 2 });
    stem.value = q.stem || '';
    stem.addEventListener('input', function () { q.stem = stem.value; });
    box.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '題幹' }), stem]));

    /* 略過此題（例如段落劃分／概括題） */
    var skipChk = U.el('input', { type: 'checkbox' });
    skipChk.checked = !!q.skip;
    skipChk.addEventListener('change', function () { q.skip = skipChk.checked; });
    box.appendChild(U.el('label.check.mt1', { style: { display: 'flex' } }, [
      skipChk,
      U.el('span', { text: '略過此題（學生不會看到、不計分）' + (q.skipReason ? '　— ' + q.skipReason : '') })
    ]));

    /* 題目截圖（原文樣式仍不夠清楚時，用截圖取代） */
    var imgPrev = U.el('div.mt1');
    var imgOnlyChk = U.el('input', { type: 'checkbox' });
    imgOnlyChk.checked = !!q.imageOnly;
    imgOnlyChk.addEventListener('change', function () { q.imageOnly = imgOnlyChk.checked; });
    function drawImg() {
      imgPrev.innerHTML = '';
      if (!q.image) return;
      imgPrev.appendChild(U.el('img', {
        src: q.image,
        style: { maxWidth: '260px', borderRadius: '6px', border: '1.5px solid var(--line)' }
      }));
    }
    var imgRow = U.el('div.row.mt1', {}, [
      U.el('button.btn.xs', {
        text: q.image ? '更換截圖' : '附加截圖',
        onclick: function () {
          U.pickFile('image/*', function (f) {
            imageToDataURL(f).then(function (d) {
              q.image = d; drawImg(); U.toast('已附加截圖（記得按儲存）', 'ok');
            }).catch(function (e) { U.toast('讀取圖片失敗：' + e.message, 'bad'); });
          });
        }
      }),
      U.el('button.btn.xs.danger', { text: '移除截圖', onclick: function () { q.image = null; drawImg(); } }),
      U.el('label.check', { style: { display: 'flex', marginLeft: '8px' } }, [
        imgOnlyChk, U.el('span', { text: '只顯示截圖（隱藏解析出的題目內容）' })
      ])
    ]);
    box.appendChild(U.el('label.tiny.muted.mt1', { text: '題目截圖（選填；上載後記得按「儲存」）' }));
    box.appendChild(imgRow);
    box.appendChild(imgPrev);
    drawImg();

    /* 分數 / 所屬文章 */
    var mk = U.el('input.input', { type: 'number', value: q.marks || 0, style: { maxWidth: '110px' } });
    mk.addEventListener('input', function () { q.marks = parseFloat(mk.value) || 0; });
    var ps = U.el('select.input', { style: { maxWidth: '180px' } });
    ps.appendChild(U.el('option', { value: '', text: '（不指定）' }));
    quiz.passages.forEach(function (p) { ps.appendChild(U.el('option', { value: p.id, text: p.title })); });
    ps.value = q.passageId || '';
    ps.addEventListener('change', function () { q.passageId = ps.value || null; });
    box.appendChild(U.el('div.inline-fields.mt1', {}, [
      U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.muted', { text: '分數' }), mk]),
      U.el('div', { style: { maxWidth: '220px' } }, [U.el('label.tiny.muted', { text: '所屬文章' }), ps])
    ]));

    /* 選擇題：選項 + 正確答案 */
    if (q.type === 'mcq') {
      var ob = U.el('div.mt2');
      ob.appendChild(U.el('label.tiny.muted', { text: '選項（勾選者為正確答案）' }));
      (q.options || []).forEach(function (o, oi) {
        var row = U.el('div.row', { style: { gap: '6px', marginBottom: '6px' } });
        var cb = U.el('input', { type: 'checkbox', style: { width: '18px', height: '18px' } });
        cb.checked = (q.answerKeys || []).indexOf(o.key) >= 0;
        cb.addEventListener('change', function () {
          q.answerKeys = (q.answerKeys || []).filter(function (k) { return k !== o.key; });
          if (cb.checked) q.answerKeys.push(o.key);
          q.answerKeys.sort();
          q.multi = q.answerKeys.length > 1;
        });
        var kt = U.el('input.input', { value: o.key, style: { maxWidth: '60px' } });
        kt.addEventListener('input', function () { o.key = U.trim(kt.value) || o.key; });
        var vt = U.el('input.input', { value: o.text, style: { flex: '1' } });
        vt.addEventListener('input', function () { o.text = vt.value; });
        row.appendChild(cb); row.appendChild(kt); row.appendChild(vt);
        row.appendChild(U.el('button.btn.xs.danger', {
          text: '✕', onclick: function () { q.options.splice(oi, 1); refresh(); }
        }));
        ob.appendChild(row);
      });
      ob.appendChild(U.el('button.btn.xs.ghost', {
        text: '＋ 選項', onclick: function () {
          var keys = (q.options || []).map(function (o) { return o.key; });
          var nk = 'ABCDEFGH'.split('').filter(function (k) { return keys.indexOf(k) < 0; })[0] || String(keys.length);
          q.options.push({ key: nk, text: '' }); refresh();
        }
      }));
      box.appendChild(ob);
    }

    /* 表格題：子題 */
    if (q.type === 'table') {
      var sb = U.el('div.mt2');
      sb.appendChild(U.el('label.tiny.muted', { text: '子題（學生看到的提示 / 正確答案）' }));
      (q.subQuestions || []).forEach(function (s2, si) {
        var row = U.el('div.subq');
        var l = U.el('input.input', { value: s2.label || '', placeholder: '標籤，如 (1)' });
        l.addEventListener('input', function () { s2.label = l.value; });
        var pr = U.el('input.input', { value: s2.prompt || '', placeholder: '提示文字（學生版該格內容）' });
        pr.addEventListener('input', function () { s2.prompt = pr.value; });
        var an = U.el('input.input', { value: s2.answer || '', placeholder: '正確答案' });
        an.addEventListener('input', function () { s2.answer = an.value; s2.marks = U.sumMarks(an.value); });
        row.appendChild(U.el('div.inline-fields', {}, [
          U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.faint', { text: '標籤' }), l]),
          U.el('div', {}, [U.el('label.tiny.faint', { text: '提示' }), pr]),
          U.el('div', {}, [U.el('label.tiny.faint', { text: '答案' }), an])
        ]));
        row.appendChild(U.el('div.row.end.mt1', {}, [
          U.el('button.btn.xs.danger', { text: '刪除子題', onclick: function () { q.subQuestions.splice(si, 1); refresh(); } })
        ]));
        sb.appendChild(row);
      });
      sb.appendChild(U.el('button.btn.xs.ghost', {
        text: '＋ 子題', onclick: function () {
          q.subQuestions.push({
            id: 'q' + q.no + '_s' + (q.subQuestions.length + 1),
            label: '(' + (q.subQuestions.length + 1) + ')', prompt: '', answer: '', marks: 0
          });
          refresh();
        }
      }));
      box.appendChild(sb);
    }

    /* 答案 / 解析 */
    var an2 = U.el('textarea.input', { rows: q.type === 'mcq' ? 1 : 3 });
    an2.value = q.answer || '';
    an2.addEventListener('input', function () { q.answer = an2.value; });
    var ex = U.el('textarea.input', { rows: 2 });
    ex.value = q.explanation || '';
    ex.addEventListener('input', function () { q.explanation = ex.value; });

    box.appendChild(U.el('div.inline-fields.mt2', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '正確答案（學生提交後會看到）' }), an2]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '答案解析' }), ex])
    ]));

    return box;
  }

  function buildPreview(quiz) {
    var d = U.el('div');
    (quiz.passages || []).forEach(function (p) {
      var holder = U.el('div.passage', { style: { marginBottom: '12px' } });
      d.appendChild(holder);
      RQ.Highlighter.readonly(holder, p, []);
    });
    (quiz.questions || []).forEach(function (q, i) {
      var box = U.el('div.q');
      if (q.skip) box.appendChild(U.el('div.tiny.faint', { text: '（此題已略過，學生不會看到）' }));
      box.appendChild(U.el('div.q-head', {}, [
        U.el('div.q-no', { text: String(q.no != null ? q.no : i + 1) }),
        U.el('div.q-stem', { html: U.esc(q.stem) })
      ]));
      if (q.image) {
        box.appendChild(U.el('div.q-image', {}, [
          U.el('img', { src: q.image, style: { maxWidth: '100%', borderRadius: '8px', border: '1.5px solid var(--line)' } })
        ]));
      }
      var qb = RQ.forms.quotesBlock(q);
      if (qb) box.appendChild(qb);
      box.appendChild(RQ.forms.input(q, {}, { disabled: true }));
      d.appendChild(box);
    });
    return d;
  }

  /* ============================================================
     ② 試卷管理
     ============================================================ */
  Teacher.quizzes = function (view) {
    var box = U.el('div');
    view.appendChild(box);
    Backend.listQuizzes().then(function (list) {
      box.innerHTML = '';
      if (!list.length) {
        box.appendChild(U.el('div.empty', {}, [
          U.el('div.big', { text: '📚' }),
          U.el('div', { text: '還沒有試卷，請到「① 上傳試卷」開始' })
        ]));
        return;
      }
      var tbl = U.el('table.tbl');
      tbl.innerHTML = '<thead><tr><th>試卷</th><th>年級</th><th>題數</th><th>分數</th><th>狀態</th><th>作業</th><th>更新</th><th>操作</th></tr></thead>';
      var tb = U.el('tbody');
      list.forEach(function (m) {
        var tr = U.el('tr');
        tr.appendChild(U.el('td', { html: U.esc(m.title) }));
        tr.appendChild(U.el('td', { text: m.level || '—' }));
        tr.appendChild(U.el('td', { text: m.questionCount || 0 }));
        tr.appendChild(U.el('td', { text: m.totalMarks || 0 }));
        tr.appendChild(U.el('td', {}, [
          U.el('span.tag' + (m.published ? '.mint' : '.gray'), { text: m.published ? '已發佈' : '草稿' }),
          m._src === 'published' || m._src === 'both' ? U.el('span.tag.sky', { text: ' repo', style: { marginLeft: '4px' } }) : null
        ]));
        var a = m.assignment;
        tr.appendChild(U.el('td', {}, [
          a ? U.el('span.tag.sun', { text: (a.all ? '全班' : (a.ids || []).length + ' 人') + (a.due ? '・' + a.due : '') })
            : U.el('span.tiny.faint', { text: '—' })
        ]));
        tr.appendChild(U.el('td', { text: U.fmtDate(m.createdAt) }));
        var ops = U.el('td');
        ops.appendChild(U.el('a.btn.xs', { href: '#/edit/' + m.id, text: '編輯' }));
        ops.appendChild(U.el('button.btn.xs.lav', {
          text: '指派', style: { marginLeft: '4px' },
          onclick: function () { Store.quiz.get(m.id).then(function (q) { assignDialog(q, function () { view.innerHTML = ''; Teacher.quizzes(view); }); }); }
        }));
        ops.appendChild(U.el('a.btn.xs', { href: '#/quiz/' + m.id, text: '試作', style: { marginLeft: '4px' } }));
        ops.appendChild(U.el('button.btn.xs', {
          text: '報表', style: { marginLeft: '4px' },
          onclick: function () { location.hash = '#/teacher/reports'; setTimeout(function () { RQ._reportQuiz = m.id; location.reload(); }, 50); }
        }));
        var onGithub = m.published || m._src === 'published' || m._src === 'both';
        var delBtn = U.el('button.btn.xs.danger', {
          text: '刪除', style: { marginLeft: '4px' },
          onclick: function () {
            var scope = '本機資料' + (onGithub ? '以及 GitHub 上的副本' : '') + '都會被移除';
            U.confirm('確定要刪除試卷「' + m.title + '」嗎？' + scope + '，此動作無法復原。', function () {
              delBtn.disabled = true;
              Backend.deleteQuiz(m.id, { cloud: true, github: true }).then(function (r) {
                if (!r.ok) { U.toast('本機刪除失敗', 'bad'); delBtn.disabled = false; return; }
                if (onGithub && r.github === false) {
                  U.toast('試卷已刪除，但 GitHub 副本刪除失敗（請稍後重試）', 'bad');
                } else {
                  U.toast('試卷已刪除', 'ok');
                }
                view.innerHTML = '';
                Teacher.quizzes(view);
              }).catch(function (e) {
                delBtn.disabled = false;
                U.toast('刪除失敗：' + ((e && e.message) || '未知錯誤'), 'bad');
              });
            });
          }
        });
        ops.appendChild(delBtn);
        tr.appendChild(ops);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      box.appendChild(U.el('div.tbl-wrap', {}, [tbl]));
    });
  };

  /* ============================================================
     ③ 學生作答報表
     ============================================================ */
  Teacher.reports = function (view) {
    var box = U.el('div');
    view.appendChild(box);
    if (Teacher._poll) { clearInterval(Teacher._poll); Teacher._poll = null; }

    Promise.all([Backend.listQuizzes(), Backend.listSubmissions()]).then(function (r) {
      var quizzes = r[0], subs = r[1];
      var sel = null;
      draw(RQ._reportQuiz || (quizzes[0] && quizzes[0].id) || null);
      RQ._reportQuiz = null;

      function reload(thenDraw) {
        return Promise.all([Backend.listQuizzes(), Backend.listSubmissions()])
          .then(function (r2) {
            quizzes = r2[0]; subs = r2[1];
            if (thenDraw) draw(sel && sel.value);
          });
      }

      function sourceBadge() {
        var src = Backend.Cloud.lastSource;
        var map = {
          firebase: ['mint', '雲端即時（Firebase）'],
          live: ['mint', '雲端即時（Apps Script）'],
          csv: ['sun', '試算表 CSV 快取（可能延遲 0–5 分鐘）'],
          offline: ['gray', '只讀本機（尚未設定雲端）']
        };
        var m = map[src] || map.offline;
        return U.el('span.tag.' + m[0], {
          text: m[1] + (Backend.Cloud.lastReadAt ? '・' + U.fmtDate(Backend.Cloud.lastReadAt, true).slice(11) : '')
        });
      }

      function draw(selId) {
        box.innerHTML = '';
        var header = U.el('div.card');
        sel = U.el('select.input', { style: { maxWidth: '320px' } });
        sel.appendChild(U.el('option', { value: '', text: '（全部試卷）' }));
        quizzes.forEach(function (q) { sel.appendChild(U.el('option', { value: q.id, text: q.title })); });
        sel.value = selId || '';
        sel.addEventListener('change', function () { draw(sel.value); });

        var refreshBtn = U.el('button.btn.sm.primary', {
          text: '重新整理',
          onclick: function () {
            refreshBtn.disabled = true; refreshBtn.textContent = '讀取中…';
            reload(true).then(function () {
              refreshBtn.disabled = false; refreshBtn.textContent = '重新整理';
              U.toast('已更新', 'ok', 1200);
            });
          }
        });
        var cbAuto = U.el('input', { type: 'checkbox' });
        cbAuto.checked = !!Teacher._poll;
        cbAuto.addEventListener('change', function () {
          if (Teacher._poll) { clearInterval(Teacher._poll); Teacher._poll = null; }
          if (cbAuto.checked) {
            Teacher._poll = setInterval(function () { reload(true); }, 45000);
            U.toast('已開啟自動更新（每 45 秒）', 'ok');
          }
        });

        header.appendChild(U.el('div.row.between', {}, [
          U.el('div.row', {}, [U.el('label.tiny.muted', { text: '選擇試卷：' }), sel]),
          U.el('div.row', {}, [
            refreshBtn,
            U.el('button.btn.sm', { text: '匯出 CSV', onclick: function () { exportCSV(sel.value, subs); } }),
            U.el('button.btn.sm', { text: '匯出 JSON', onclick: function () { exportJSON(sel.value, subs); } })
          ])
        ]));
        header.appendChild(U.el('div.row.between.mt2', {}, [
          U.el('div.row', {}, [
            sourceBadge(),
            U.el('label.check', {}, [cbAuto, U.el('span.tiny', { text: '每 45 秒自動更新' })])
          ]),
          (function () {
            var su = (Settings.get().hook || {}).sheetUrl;
            return su ? U.el('a.btn.sm.ghost', {
              href: su, target: '_blank', rel: 'noopener', text: '直接開試算表（最即時）'
            }) : null;
          })()
        ]));
        box.appendChild(header);

        var list = sel.value ? subs.filter(function (s) { return s.quizId === sel.value; }) : subs;
        var quiz = quizzes.filter(function (q) { return q.id === sel.value; })[0];

        if (!list.length) {
          var tip = Backend.Cloud.lastSource === 'csv'
            ? '若學生剛送出，試算表 CSV 快取可能要幾分鐘才更新，請按「重新整理」或直接用上方「直接開試算表」確認。'
            : (Backend.Cloud.driver() === 'offline'
              ? '目前沒有設定雲端，學生的作答只存在他自己的裝置上，請先到「⑤ 資料與同步」設定。'
              : '學生送出後會出現在這裡。');
          box.appendChild(U.el('div.empty', {}, [
            U.el('div.big', { text: '📝' }),
            U.el('div', { text: '這份試卷還沒有人作答' }),
            U.el('small', { text: tip })
          ]));
          return;
        }

        /* 統計 */
        var scores = list.map(function (s) { return (s.score && s.score.total) || 0; });
        var max = (quiz && quiz.totalMarks) || (list[0].score && list[0].score.max) || 0;
        var avg = scores.reduce(function (a, b) { return a + b; }, 0) / (scores.length || 1);
        var stats = U.el('div.grid.g4.mb0');
        [
          ['作答人次', list.length],
          ['平均分數', (Math.round(avg * 10) / 10) + (max ? ' / ' + max : '')],
          ['平均正確率', U.percent(avg, max) + '%'],
          ['平均用時', U.fmtDur(Math.round(list.reduce(function (a, s) { return a + (s.durationSec || 0); }, 0) / list.length))]
        ].forEach(function (x) {
          stats.appendChild(U.el('div.stat', {}, [U.el('b', { text: String(x[1]) }), U.el('span', { text: x[0] })]));
        });
        box.appendChild(stats);

        /* 明細表 */
        var tbl = U.el('table.tbl');
        tbl.innerHTML = '<thead><tr><th>學生</th><th>提交時間</th><th>得分</th><th>正確率</th><th>用時</th><th>標記</th><th>生詞</th><th>操作</th></tr></thead>';
        var tb = U.el('tbody');
        list.forEach(function (s) {
          var tr = U.el('tr');
          tr.appendChild(U.el('td', { html: U.esc(s.studentName || s.username || s.studentId) }));
          tr.appendChild(U.el('td', { text: U.fmtDate(s.submittedAt, true) }));
          tr.appendChild(U.el('td', { html: '<b>' + ((s.score && s.score.total) || 0) + '</b> / ' + ((s.score && s.score.max) || max || 0) }));
          var pct = U.percent((s.score && s.score.total) || 0, (s.score && s.score.max) || max || 0);
          tr.appendChild(U.el('td', {}, [
            U.el('div.bar.' + U.barClass(pct), { style: { margin: '0', height: '8px' } }, [U.el('i', { style: { width: pct + '%' } })]),
            U.el('small', { text: pct + '%' })
          ]));
          tr.appendChild(U.el('td', { text: U.fmtDur(s.durationSec) }));
          tr.appendChild(U.el('td', { text: (s.marks || []).length }));
          tr.appendChild(U.el('td', {
            html: (s.vocab || []).length
              ? '<span class="tag pink">' + (s.vocab || []).map(function (v) { return U.esc(v.word); }).join('、') + '</span>'
              : '—'
          }));
          tr.appendChild(U.el('td', {}, [
            U.el('button.btn.xs.primary', { text: '查看', onclick: function () { detail(s, quiz); } })
          ]));
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        box.appendChild(U.el('div.tbl-wrap', {}, [tbl]));

        /* 誰還沒交 */
        Backend.getRoster().then(function (roster) {
          if (!roster.length) return;
          var doneIds = {};
          list.forEach(function (s) { doneIds[s.studentId] = 1; });
          var notDone = roster.filter(function (st) { return !doneIds[st.id]; });
          var card2 = U.el('div.card.mt3');
          card2.appendChild(U.el('h3', {
            text: '尚未提交（' + notDone.length + ' / ' + roster.length + ' 人）'
          }));
          if (!notDone.length) {
            card2.appendChild(U.el('div.tiny.muted', { text: '全部都交了 🎉' }));
          } else {
            card2.appendChild(U.el('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
              notDone.map(function (st) {
                return U.el('span.tag.gray', { text: (st.name || st.username) + (st.className ? '（' + st.className + '）' : '') });
              })
            ));
          }
          box.appendChild(card2);
        });
      }
    });
  };

  /**
   * 查看單一學生的作答詳情。
   * 注意：必需要用 Backend.getQuiz() 拿「完整試卷」，
   * listQuizzes() 回傳的只是摘要（沒有 questions），直接拿來用會炸。
   */
  function detail(sub, quiz) {
    var d = U.el('div');
    var loading = U.el('div.empty', { text: '載入試卷題目中…' });
    d.appendChild(loading);
    var m = U.modal({ title: '作答詳情', width: 880, body: d, actions: [{ label: '關閉' }] });

    Promise.resolve(
      (quiz && quiz.questions) ? quiz : Backend.getQuiz(sub.quizId)
    ).then(function (full) {
      d.innerHTML = '';
      renderDetail(d, sub, full);
    }).catch(function (e) {
      d.innerHTML = '';
      d.appendChild(U.el('div.warnbox', { text: '無法載入試卷：' + (e.message || e) }));
    });
    return m;
  }

  function renderDetail(d, sub, quiz) {
    var head = U.el('div.row.between', {}, [
      U.el('div', {}, [
        U.el('h3.mb0', { text: (sub.studentName || sub.username || '') + ' 的作答' }),
        U.el('div.tiny.muted', {
          text: U.fmtDate(sub.submittedAt, true) + '　用時 ' + U.fmtDur(sub.durationSec) +
            '　得分 ' + ((sub.score && sub.score.total) || 0) + ' / ' + ((sub.score && sub.score.max) || 0)
        })
      ])
    ]);
    d.appendChild(head);

    if (!quiz) {
      d.appendChild(U.el('div.warnbox.mt2', { text: '找不到對應試卷，僅顯示原始作答內容。' }));
    }

    (quiz ? quiz.questions : []).forEach(function (q, i) {
      var box = U.el('div.q');
      box.appendChild(U.el('div.q-head', {}, [
        U.el('div.q-no', { text: String(q.no != null ? q.no : i + 1) }),
        U.el('div.q-stem', { html: U.esc(q.stem) + '　<span class="tag sun">' + (q.marks || 0) + ' 分</span>' })
      ]));
      var ans = sub.answers[q.id] || {};
      box.appendChild(U.el('div.ansbox.mt1', {}, [
        U.el('span.lbl', { text: '學生作答' }),
        U.el('div', { html: U.nl2br(RQ.forms.answerText(q, ans)) })
      ]));
      box.appendChild(RQ.forms.reveal(q, ans));

      /* 手動給分 */
      var mk = U.el('input.input', { type: 'number', value: (ans.manualScore != null ? ans.manualScore : ''), placeholder: '0 ~ ' + (q.marks || 0), style: { maxWidth: '110px' } });
      var cm = U.el('input.input', { value: ans.teacherComment || '', placeholder: '評語（學生會看到）' });
      var saveBtn = U.el('button.btn.xs.primary', {
        text: '儲存給分', onclick: function () {
          ans.manualScore = mk.value === '' ? null : (parseFloat(mk.value) || 0);
          ans.teacherComment = U.trim(cm.value);
          sub.answers[q.id] = ans;
          recalc(sub, quiz);
          Store.submission.save(sub).then(function () {
            Backend.saveSubmission(sub);
            U.toast('已儲存', 'ok');
          });
        }
      });
      box.appendChild(U.el('div.inline-fields.mt1', {}, [
        U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.muted', { text: '老師給分' }), mk]),
        U.el('div', {}, [U.el('label.tiny.muted', { text: '評語' }), cm])
      ]));
      box.appendChild(U.el('div.mt1', {}, [saveBtn]));
      d.appendChild(box);
    });

    /* 標記與筆記 */
    if ((sub.marks || []).length) {
      var mc = U.el('div.card.mt2');
      mc.appendChild(U.el('h3', { text: '螢光標示與筆記（' + sub.marks.length + ' 處）' }));
      sub.marks.forEach(function (m) {
        mc.appendChild(U.el('div.row', { style: { padding: '4px 0', borderBottom: '1px dashed var(--line)' } }, [
          U.el('span.hl.' + (m.color || 'yellow'), { text: m.text, style: { padding: '2px 8px', borderRadius: '6px' } }),
          U.el('span.tiny.muted', { text: m.note || '（無筆記）' })
        ]));
      });
      d.appendChild(mc);
    }
    if ((sub.vocab || []).length) {
      var vc = U.el('div.card.mt2');
      vc.appendChild(U.el('h3', { text: '不懂的詞語（' + sub.vocab.length + '）' }));
      sub.vocab.forEach(function (v) {
        vc.appendChild(U.el('div.row', { style: { padding: '4px 0' } }, [
          U.el('b', { text: v.word, style: { minWidth: '120px' } }),
          U.el('span.tiny.muted', { text: v.note || '' })
        ]));
      });
      d.appendChild(vc);
    }
    if ((sub.notes || []).length) {
      var nc = U.el('div.card.mt2');
      nc.appendChild(U.el('h3', { text: '篇章筆記' }));
      sub.notes.forEach(function (n) {
        nc.appendChild(U.el('div', { html: '<b>' + U.esc(n.pid) + '：</b>' + U.nl2br(n.text) }));
      });
      d.appendChild(nc);
    }

    /* 遠端同步狀態 */
    var syncTxt = sub._synced
      ? '雲端同步：' + sub._synced + (sub._syncError ? '（失敗：' + sub._syncError + '）' : '')
      : '本機記錄';
    d.appendChild(U.el('div.tiny.faint.mt2', { text: syncTxt }));
  }

  function recalc(sub, quiz) {
    var auto = 0, manual = 0, max = quiz ? (quiz.totalMarks || 0) : ((sub.score && sub.score.max) || 0);
    (quiz ? quiz.questions : []).forEach(function (q) {
      var a = sub.answers[q.id] || {};
      var got = RQ.forms.autoScore(q, a);
      if (got !== null) auto += got;
      else if (a.manualScore != null) manual += a.manualScore;
    });
    sub.score = Object.assign({}, sub.score || {}, {
      auto: auto, manual: manual, total: auto + manual, max: max, graded: true
    });
  }

  function exportCSV(quizId, subs) {
    var list = quizId ? subs.filter(function (s) { return s.quizId === quizId; }) : subs;
    var rows = [['學生', '試卷', '提交時間', '用時(秒)', '自動得分', '老師給分', '總分', '滿分', '正確率%', '標記數', '生詞']];
    list.forEach(function (s) {
      var sc = s.score || {};
      rows.push([
        s.studentName || s.username || '', s.quizTitle || '', s.submittedAt || '', s.durationSec || 0,
        sc.auto || 0, sc.manual || 0, sc.total || 0, sc.max || 0,
        U.percent(sc.total || 0, sc.max || 0),
        (s.marks || []).length,
        (s.vocab || []).map(function (v) { return v.word; }).join(' / ')
      ]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    U.download('成績報表_' + U.fmtDate(U.nowISO()) + '.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
  }

  function exportJSON(quizId, subs) {
    var list = quizId ? subs.filter(function (s) { return s.quizId === quizId; }) : subs;
    U.download('作答記錄_' + U.fmtDate(U.nowISO()) + '.json', JSON.stringify(list, null, 2));
  }

  /* ============================================================
     ④ 學生名冊
     ============================================================ */
  Teacher.roster = function (view) {
    var box = U.el('div');
    view.appendChild(box);

    var addCard = U.el('div.card');
    addCard.appendChild(U.el('h3', { text: '新增學生帳號' }));
    var un = U.el('input.input', { placeholder: '登入帳號（英文/數字）' });
    var nm = U.el('input.input', { placeholder: '姓名' });
    var cl = U.el('input.input', { placeholder: '班別（選填）' });
    var pw = U.el('input.input', { placeholder: '密碼' });
    addCard.appendChild(U.el('div.inline-fields', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '帳號' }), un]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '姓名' }), nm]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '班別' }), cl]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '密碼' }), pw])
    ]));
    addCard.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '新增', onclick: function () {
          var u = U.trim(un.value), p = U.trim(pw.value);
          if (!u || !p) { U.toast('帳號與密碼必填', 'bad'); return; }
          Backend.getRoster().then(function (list) {
            if (list.filter(function (x) { return x.username === u; }).length) { U.toast('此帳號已存在', 'bad'); return; }
            return RQ.crypto.hashPassword(p).then(function (h) {
              return Backend.saveStudent({
                id: U.uid('stu'), username: u, name: U.trim(nm.value) || u,
                className: U.trim(cl.value), pass: h, createdAt: U.nowISO()
              });
            });
          }).then(function () {
            un.value = nm.value = cl.value = pw.value = '';
            U.toast('已新增', 'ok'); draw();
          });
        }
      }),
      U.el('button.btn.sm.ghost', {
        text: '匯入名冊 JSON', onclick: function () {
          U.pickFile('.json', function (f) {
            U.readFileAsText(f).then(function (txt) {
              var arr = JSON.parse(txt);
              if (!Array.isArray(arr)) throw new Error('格式應為陣列');
              return arr.reduce(function (acc, s) {
                return acc.then(function () { return Backend.saveStudent(s); });
              }, Promise.resolve());
            }).then(function () { U.toast('匯入完成', 'ok'); draw(); })
              .catch(function (e) { U.toast('匯入失敗：' + e.message, 'bad'); });
          });
        }
      }),
      U.el('button.btn.sm', {
        text: '下載名冊', onclick: function () {
          Backend.getRoster().then(function (l) { U.download('roster.json', JSON.stringify(l, null, 2)); });
        }
      }),
      U.el('button.btn.sm.sun', {
        text: '發佈到 GitHub', onclick: function () {
          Backend.getRoster().then(function (l) {
            return Backend.publishRoster(l);
          }).then(function () { U.toast('名冊已寫入 repo 的 data/roster.json', 'ok'); })
            .catch(function (e) { U.toast('失敗：' + e.message, 'bad'); });
        }
      })
    ]));
    view.appendChild(addCard);

    var listBox = U.el('div.card');
    view.appendChild(listBox);
    draw();

    function draw() {
      Backend.getRoster().then(function (list) {
        listBox.innerHTML = '';
        listBox.appendChild(U.el('h3', { text: '學生名冊（' + list.length + ' 人）' }));
        if (!list.length) {
          listBox.appendChild(U.el('div.tiny.muted', { text: '尚未建立任何學生帳號。' }));
          return;
        }
        var tbl = U.el('table.tbl');
        tbl.innerHTML = '<thead><tr><th>帳號</th><th>姓名</th><th>班別</th><th>建立時間</th><th>操作</th></tr></thead>';
        var tb = U.el('tbody');
        list.forEach(function (s) {
          var tr = U.el('tr');
          tr.appendChild(U.el('td', { text: s.username }));
          tr.appendChild(U.el('td', { text: s.name || '' }));
          tr.appendChild(U.el('td', { text: s.className || '—' }));
          tr.appendChild(U.el('td', { text: U.fmtDate(s.createdAt) }));
          tr.appendChild(U.el('td', {}, [
            U.el('button.btn.xs', {
              text: '重設密碼', onclick: function () {
                var inp = U.el('input.input', { placeholder: '新密碼' });
                U.modal({
                  title: '重設 ' + (s.name || s.username) + ' 的密碼', body: inp,
                  actions: [{ label: '取消' }, {
                    label: '設定', kind: 'primary', onClick: function () {
                      var v = U.trim(inp.value);
                      if (!v) return false;
                      return RQ.crypto.hashPassword(v).then(function (h) {
                        s.pass = h; return Backend.saveStudent(s);
                      }).then(function () { U.toast('已重設', 'ok'); });
                    }
                  }]
                });
              }
            }),
            U.el('button.btn.xs.danger', {
              text: '刪除', style: { marginLeft: '4px' }, onclick: function () {
                U.confirm('刪除 ' + (s.name || s.username) + '？', function () {
                  Store.roster.del(s.id).then(draw);
                });
              }
            })
          ]));
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        listBox.appendChild(U.el('div.tbl-wrap', {}, [tbl]));
      });
    }
  };

  /* ============================================================
     ⑤ 資料與同步
     ============================================================ */
  Teacher.data = function (view) {
    var s = Settings.get();

    /* ---------- 雲端同步（學生跨裝置 + 老師即時看到） ---------- */
    var fb = U.el('div.card');
    fb.appendChild(U.el('h3', { text: '① 雲端同步（讓學生用手機／iPad／電腦都能用）' }));
    fb.appendChild(U.el('div.infobox', {
      html: '沒有設定雲端時，學生的作答只存在他自己的瀏覽器裡，你看不到。<br>' +
        '底下<b>任選一種</b>填好並按「啟用並測試」即可：' +
        '<b>Firebase</b>（即時、最順）或 <b>Google Apps Script</b>（免費無上限）。'
    }));

    var fbUrl = U.el('input.input', { value: (s.fb || {}).dbUrl || '', placeholder: 'https://你的專案.firebaseio.com' });
    var fbKey = U.el('input.input', { value: (s.fb || {}).apiKey || '', placeholder: 'Web API Key（AIza…）' });
    var fbCode = U.el('input.input', { value: (s.fb || {}).classCode || '', placeholder: '例如：2A-CHI' });
    fb.appendChild(U.el('div', {}, [U.el('label.tiny.muted', { text: 'Firebase Realtime Database URL' }), fbUrl]));
    fb.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: 'Firebase Web API Key' }), fbKey]));
    fb.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '班級代碼（所有資料放在這個命名空間下）' }), fbCode]));
    fb.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '啟用 Firebase 並測試', onclick: function () {
          Settings.set({ fb: { enabled: true, dbUrl: U.trim(fbUrl.value), apiKey: U.trim(fbKey.value), classCode: U.trim(fbCode.value) } });
          Backend.Cloud.test().then(function (r) {
            U.toast('雲端連線成功（' + r.driver + '）', 'ok', 3600);
            Teacher.render(view, 'data');
          }).catch(function (e) { U.toast('連線失敗：' + e.message, 'bad', 4200); });
        }
      }),
      U.el('button.btn.sm.ghost', {
        text: '停用 Firebase', onclick: function () {
          Settings.set({ fb: { enabled: false } });
          U.toast('已停用'); Teacher.render(view, 'data');
        }
      })
    ]));
    fb.appendChild(U.el('div.tiny.faint.mt2', {
      html: 'Firebase 免費額度（Spark）：' +
        'Realtime Database 1 GB 儲存／每月 10 GB 流量，' +
        '一個班級綽綽有餘。<b>API Key 本來就設計成放在前端</b>，' +
        '真正的防護是資料庫規則：' +
        '<code>{"rules":{"rq":{".read":"auth != null",".write":"auth != null"}}}</code>（只允許匿名登入者）。'
    }));
    view.appendChild(fb);

    /* 註冊設定 */
    var reg = U.el('div.card');
    reg.appendChild(U.el('h3', { text: '② 學生註冊方式' }));
    var cbSelf = U.el('input', { type: 'checkbox' });
    cbSelf.checked = !!s.allowSelfRegister;
    var codeInp = U.el('input.input', { value: s.classCode || '', placeholder: '例如 2A-CHI', style: { maxWidth: '220px' } });
    reg.appendChild(U.el('label.check', { style: { display: 'flex', marginBottom: '8px' } }, [
      cbSelf, U.el('span', { text: '開放學生自助註冊（學生填姓名＋自選帳號＋密碼＋班級代碼）' })
    ]));
    reg.appendChild(U.el('div.row', {}, [
      U.el('label.tiny.muted', { text: '班級代碼：' }), codeInp,
      U.el('span.tiny.faint', { text: '（告訴學生這組代碼；Apps Script 端也要填一樣的 CLASS_CODE）' })
    ]));
    reg.appendChild(U.el('div.mt2', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存註冊設定', onclick: function () {
          Settings.set({ allowSelfRegister: cbSelf.checked, classCode: U.trim(codeInp.value) });
          U.toast('已儲存', 'ok');
        }
      })
    ]));
    reg.appendChild(U.el('div.tiny.faint.mt2', {
      html: '邏輯：學生自助註冊後，帳號會寫進雲端名冊 → 你在「④ 學生名冊」立刻看到 → ' +
        '學生在任何裝置用同一組帳號密碼登入，作答進度與提交結果都跟著帳號走。'
    }));
    view.appendChild(reg);

    var gh = U.el('div.card');
    gh.appendChild(U.el('h3', { text: '③ GitHub 設定（老師端：試卷長期保存）' }));
    gh.appendChild(U.el('div.infobox', {
      html: 'Token 只會存在<b>這台電腦的 localStorage</b>，不會寫進程式碼、也不會上傳。' +
        '建議使用 <b>fine-grained token</b>，只授權單一 repo 的 Contents 讀寫，並設定到期日。'
    }));
    var o = U.el('input.input', { value: s.gh.owner, placeholder: 'GitHub 使用者名稱' });
    var r = U.el('input.input', { value: s.gh.repo, placeholder: 'repo 名稱' });
    var b = U.el('input.input', { value: s.gh.branch, placeholder: 'main' });
    var tk = U.el('input.input', { type: 'password', value: s.gh.token, placeholder: 'ghp_...' });
    gh.appendChild(U.el('div.inline-fields', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '擁有者 owner' }), o]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: 'repo' }), r]),
      U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.muted', { text: '分支' }), b]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: 'Personal Access Token' }), tk])
    ]));
    gh.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存並測試連線', onclick: function () {
          Settings.set({ gh: { owner: U.trim(o.value), repo: U.trim(r.value), branch: U.trim(b.value) || 'main', token: U.trim(tk.value) } });
          Backend.GitHub.test().then(function (info) {
            U.toast('連線成功：' + info.full_name, 'ok', 3200);
          }).catch(function (e) { U.toast('連線失敗：' + e.message, 'bad', 3600); });
        }
      }),
      U.el('button.btn.sm.danger', {
        text: '清除 Token', onclick: function () {
          Settings.set({ gh: { token: '' } }); tk.value = '';
          U.toast('已清除本機 Token');
        }
      })
    ]));
    view.appendChild(gh);

    var hk = U.el('div.card');
    hk.appendChild(U.el('h3', { text: '④ 學生作答收集端（Google Apps Script）' }));
    hk.appendChild(U.el('div.infobox', {
      html: '學生不能用你的 Token 寫入 repo，所以提交要經由另一個免費端點。' +
        '最簡單的做法是用 <b>Google Apps Script</b>（免費、無流量上限），程式碼放在 <code>tools/apps-script.gs</code>。' +
        '送出用 Web App 網址；老師讀取用「試算表發佈成 CSV」的網址（Google 允許跨網域讀取）。'
    }));
    var pu = U.el('input.input', { value: s.hook.postUrl, placeholder: 'https://script.google.com/macros/s/.../exec' });
    var gu = U.el('input.input', { value: s.hook.getUrl, placeholder: 'https://docs.google.com/spreadsheets/d/e/.../pub?output=csv' });
    var wk = U.el('input.input', { value: s.hook.key || '', placeholder: '可留空（對應 Apps Script 的 WRITE_KEY）' });
    var su = U.el('input.input', { value: s.hook.sheetUrl || '', placeholder: 'https://docs.google.com/spreadsheets/d/.../edit（選填）' });
    hk.appendChild(U.el('div', {}, [U.el('label.tiny.muted', { text: '送出網址（POST，Web App 的 /exec）' }), pu]));
    hk.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '讀取網址（GET，試算表發佈成 CSV）' }), gu]));
    hk.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '試算表網址（選填，報表頁會有「直接開試算表」按鈕）' }), su]));
    hk.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '寫入金鑰（選填）' }), wk]));
    hk.appendChild(U.el('div.warnbox.mt2', {
      html: '<b>關於即時性：</b>學生一按提交，資料<b>立刻</b>寫進你的 Google 試算表' +
        '（這部分沒有延遲）。但網站的報表是讀「試算表發佈成 CSV」的網址，' +
        'Google 對它有快取，通常 <b>0–5 分鐘</b>才會更新。' +
        '程式會先嘗試即時讀取（/exec），多數瀏覽器會因 CORS 擋住而改走 CSV。' +
        '<b>想要秒級即時，請改用 Firebase。</b>'
    }));
    var cbDraft = U.el('input', { type: 'checkbox' });
    cbDraft.checked = s.cloudDraft !== false;
    hk.appendChild(U.el('div.mt2', {}, [
      U.el('label.check', { style: { display: 'flex' } }, [cbDraft, U.el('span', { text: '學生作答進度同步到雲端（換裝置可接續）' })])
    ]));
    var sm = U.el('select.input', { style: { maxWidth: '260px' } });
    [['offline', '只存本機（離線可用）'], ['webhook', '本機 + 傳到收集端'], ['github', '本機 + 寫入 GitHub repo']].forEach(function (x) {
      sm.appendChild(U.el('option', { value: x[0], text: x[1] }));
    });
    sm.value = s.submitMode || 'offline';
    hk.appendChild(U.el('div.mt2', {}, [U.el('label.tiny.muted', { text: '學生提交方式（若已用 Firebase 就不用改）' }), sm]));
    hk.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存', onclick: function () {
          Settings.set({
            hook: {
              postUrl: U.trim(pu.value), getUrl: U.trim(gu.value),
              key: U.trim(wk.value), sheetUrl: U.trim(su.value)
            },
            submitMode: sm.value, cloudDraft: cbDraft.checked
          });
          U.toast('已儲存', 'ok');
        }
      }),
      U.el('button.btn.sm', {
        text: '測試雲端讀取', onclick: function () {
          Backend.Cloud.getAll('submission').then(function (l) {
            U.toast('讀到 ' + l.length + ' 筆作答（' + Backend.Cloud.driver() + '）', 'ok');
          }).catch(function (e) { U.toast('讀取失敗：' + e.message, 'bad'); });
        }
      }),
      U.el('button.btn.sm', {
        text: '重試未同步的作答', onclick: function () {
          Backend.retryPending().then(function (n) { U.toast('已補送 ' + n + ' 筆', 'ok'); });
        }
      })
    ]));
    view.appendChild(hk);

    var sync = U.el('div.card');
    sync.appendChild(U.el('h3', { text: '⑤ 同步與備份' }));
    sync.appendChild(U.el('div.row', {}, [
      U.el('button.btn.sm', {
        text: '從 repo 拉取試卷', onclick: function () {
          Backend.pullQuizzes().then(function (n) { U.toast('拉取 ' + n + ' 份試卷', 'ok'); })
            .catch(function (e) { U.toast(e.message, 'bad'); });
        }
      }),
      U.el('button.btn.sm', {
        text: '封存作答到 repo', onclick: function () {
          Backend.archiveSubmissions().then(function (n) { U.toast('封存 ' + n + ' 筆', 'ok'); })
            .catch(function (e) { U.toast(e.message, 'bad'); });
        }
      }),
      U.el('button.btn.sm', {
        text: '匯出全部資料（JSON）', onclick: function () {
          Store.exportAll().then(function (b) { U.download('rq-backup-' + U.fmtDate(U.nowISO()) + '.json', JSON.stringify(b, null, 2)); });
        }
      }),
      U.el('button.btn.sm', {
        text: '匯入備份', onclick: function () {
          U.pickFile('.json', function (f) {
            U.readFileAsText(f).then(function (t) {
              var b = JSON.parse(t);
              return Store.importAll(b, 'merge');
            }).then(function () { U.toast('匯入完成', 'ok'); })
              .catch(function (e) { U.toast('匯入失敗：' + e.message, 'bad'); });
          });
        }
      })
    ]));
    sync.appendChild(U.el('div.mt2', {}, [
      U.el('label.check', {}, [
        (function () {
          var c = U.el('input', { type: 'checkbox' });
          c.checked = !!Settings.get().allowRetake;
          c.addEventListener('change', function () { Settings.set({ allowRetake: c.checked }); });
          return c;
        })(),
        U.el('span', { text: '允許學生重複作答同一份試卷' })
      ])
    ]));
    view.appendChild(sync);
  };

  RQ.teacher = Teacher;
})(window.RQ);
