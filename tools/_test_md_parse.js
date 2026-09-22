/* _test_md_parse.js — 用 Node 直接驗證 Markdown／純文字解析路徑
   載入真的 docx-parser.js 與 md-parser.js（需要最小 DOM shim）
   執行： node tools/_test_md_parse.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------- 最小 DOM shim（只夠 docx-parser 載入用） ---------- */
function makeShim() {
  const doc = {
    createElement() {
      const el = {
        nodeType: 1, tagName: 'DIV', localName: 'div',
        childNodes: [], attributes: {}, style: {}, dataset: {},
        appendChild(c) { this.childNodes.push(c); return c; },
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        addEventListener() { }, removeChild() { },
        querySelector() { return null; }, querySelectorAll() { return []; },
        getElementsByTagName() { return []; },
        classList: { add() { }, remove() { } }
      };
      return el;
    },
    getElementById() { return null; },
    body: { appendChild() { }, removeChild() { } },
    documentElement: {}
  };
  return doc;
}

const sandbox = {
  console,
  window: {},
  document: makeShim(),
  DOMParser: class { parseFromString() { return { getElementsByTagName: () => [] }; } },
  FileReader: class { },
  Blob: class { constructor(parts, opt) { this.parts = parts; this.type = (opt || {}).type || ''; } },
  File: class { },
  URL: { createObjectURL: () => '', revokeObjectURL: () => { } },
  setTimeout, clearTimeout, Date, Math, JSON, Promise, RegExp, String, Number, Array, Object,
  fetch: () => Promise.reject(new Error('no network in test'))
};
sandbox.window.RQ = {};
sandbox.self = sandbox.window;
vm.createContext(sandbox);

/* util 需要 localStorage */
sandbox.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};

const load = (p) => vm.runInContext(read(p), sandbox, { filename: p });
load('assets/js/core/util.js');
load('assets/js/core/crypto.js');
load('assets/js/core/store.js');
load('assets/js/core/ai.js');
load('assets/js/core/docx-parser.js');
load('assets/js/core/md-parser.js');

const RQ = sandbox.window.RQ;
const Md = RQ.md;
const Docx = RQ.docx;

/* ---------- 測試框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r === false) { fail++; failures.push(name + '  → 回傳 false'); return; }
    pass++;
  } catch (e) {
    fail++; failures.push(name + '  → ' + (e && e.message ? e.message : e));
  }
}
function eq(a, b, msg) {
  if (String(a) !== String(b)) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + '，得到 ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || '應為真'); }
function has(s, sub, msg) {
  if (String(s).indexOf(sub) < 0) throw new Error((msg || '') + ' 找不到 ' + JSON.stringify(sub) + '；實得 ' + JSON.stringify(String(s).slice(0, 300)));
}

/* ============================================================
   1. stripInline
   ============================================================ */
t('stripInline 去掉粗體／斜體／行內程式碼／連結', () => {
  eq(Md.stripInline('**答案**是*這個*與`code`'), '答案是這個與code');
  eq(Md.stripInline('[文字](http://x)'), '文字');
  eq(Md.stripInline('~~刪~~線'), '刪線');
  eq(Md.stripInline('保留__底線__成語'), '保留底線成語');
});

t('stripInline 不破壞純中文標點', () => {
  eq(Md.stripInline('《岳陽樓記》——「先天下之憂而憂」'), '《岳陽樓記》——「先天下之憂而憂」');
});

/* ============================================================
   2. 前處理：分頁標記、標題、表格、答案行
   ============================================================ */
t('preprocess 去掉 ===== Page N ===== 並記錄頁數', () => {
  const r = Md.preprocess('A\n===== Page 2 =====\nB\n===== Page 3 =====\nC');
  eq(r.meta.pageCount, 3);
  ok(r.lines.indexOf('===== Page 2 =====') < 0, '分頁標記應被移除');
  ok(r.lines.some(l => l === 'B'), 'B 應保留');
});

t('preprocess 第一個 # 當標題', () => {
  const r = Md.preprocess('# 2020-DSE 中國語文 卷一 閱讀能力\n1. 題目（2分）');
  eq(r.meta.title, '2020-DSE 中國語文 卷一 閱讀能力');
  ok(r.meta.titleFromHeading, '應標為 heading 來源');
});

t('preprocess ## 第二篇 保留成可被 RE_PASS 抓到的形式', () => {
  const r = Md.preprocess('## 第二篇\n內文');
  eq(r.meta.headings.length, 1);
  ok(r.lines.indexOf('第二篇') >= 0, '應留下「第二篇」；實得 ' + JSON.stringify(r.lines));
});

t('preprocess Markdown 表格 → {cells}', () => {
  const r = Md.preprocess('| 典故 | 內容 |\n| --- | --- |\n| 甲 | 乙 |');
  eq(r.meta.tableRows, 2, '兩列資料（分隔列不算）');
  const rows = r.lines.filter(l => l && l.cells);
  eq(rows.length, 2);
  eq(rows[0].cells.join(','), '典故,內容');
  eq(rows[1].cells.join(','), '甲,乙');
});

t('preprocess 表格分隔列 |---|---| 不會變成資料列', () => {
  const r = Md.preprocess('| A | B |\n|---|---|\n| 1 | 2 |');
  const rows = r.lines.filter(l => l && l.cells);
  eq(rows.length, 2);
  ok(rows.every(x => !/^-+$/.test(x.cells[0])), '不應有分隔列');
});

t('preprocess 表格欄內含跳脫的 \\|', () => {
  const r = Md.preprocess('| a \\| b | c |');
  const row = r.lines.filter(l => l && l.cells)[0];
  eq(row.cells[0], 'a | b');
});

t('preprocess 全粗體行 + 教師版區段 → ★ 答案行', () => {
  const r = Md.preprocess('**1. B**\n\n═══ 教師版 ═══\n**3. C**');
  const stars = r.lines.filter(l => typeof l === 'string' && /^★/.test(l));
  ok(stars.length >= 1, '應產生 ★ 行；實得 ' + JSON.stringify(r.lines));
});

t('preprocess ★／✔ 開頭行原樣變成 ★ 行', () => {
  const r = Md.preprocess('★ 3. B\n✔ 5. 承先啟後');
  const stars = r.lines.filter(l => typeof l === 'string' && /^★/.test(l));
  eq(stars.length, 2);
  has(stars[0], '3. B');
});

t('preprocess 【答案】標記 → ★ 行', () => {
  const r = Md.preprocess('【答案】B');
  const stars = r.lines.filter(l => typeof l === 'string' && /^★/.test(l));
  eq(stars.length, 1);
  eq(stars[0], '★ B');
});

t('preprocess 題目行的粗體不會被當成答案行', () => {
  const r = Md.preprocess('**1. 以下哪一項最適合？（2分）**');
  const stars = r.lines.filter(l => typeof l === 'string' && /^★/.test(l));
  eq(stars.length, 0, '題目不該變成答案行；實得 ' + JSON.stringify(r.lines));
  ok(r.lines.some(l => /以下哪一項最適合/.test(l)), '題目應保留');
});

t('preprocess 清單：1. 保留題號、- 去掉記號', () => {
  const r = Md.preprocess('1. 題目（2分）\n- A. 甲\n- B. 乙');
  ok(r.lines.indexOf('1. 題目（2分）') >= 0, '有序清單保留題號；實得 ' + JSON.stringify(r.lines));
  ok(r.lines.indexOf('A. 甲') >= 0, '無序清單去記號');
});

t('preprocess 程式碼圍籬內容全部略過', () => {
  const r = Md.preprocess('前\n```\n1. 這不是題目（2分）\n```\n後');
  ok(!r.lines.some(l => /這不是題目/.test(l)), '圍籬內不應出現');
});

t('preprocess 整行分隔線 → 空行', () => {
  const r = Md.preprocess('A\n───────\nB');
  ok(!r.lines.some(l => /─{3,}/.test(l)), '分隔線應被移除');
});

t('preprocess [選擇方格：A B C D] 會被轉成選項記號（PDF／DSE 文字版常見）', () => {
  const r = Md.preprocess('1. 題目（2分）\n[選擇方格：A B C D]');
  const line = r.lines.filter(l => typeof l === 'string' && /A\./.test(l))[0];
  ok(line, '應產生選項行；實得 ' + JSON.stringify(r.lines));
  const blocks = Md.blocksFromMixed(r.lines);
  const opts = blocks.reduce((a, b) => a.concat(b.options || []), []);
  eq(opts.map(o => o.key).join(','), 'A,B,C,D');
});

t('preprocess 已有「閱讀能力考材」時不會補第二次', () => {
  const r = Md.preprocess('# T\n閱讀能力考材\n## 第一篇\n內文');
  eq(r.lines.filter(l => l === '閱讀能力考材').length, 1);
  ok(!r.meta.synthMat);
});

t('preprocess 沒「閱讀能力考材」但有「第X篇」→ 自動補上', () => {
  const r = Md.preprocess('# T\n## 第一篇\n內文超過二十五個字才會被當成正文段落，所以這裡刻意寫長一點點。\n－完－');
  ok(r.meta.synthMat, '應標記 synthMat');
  const i = r.lines.indexOf('閱讀能力考材');
  const j = r.lines.indexOf('第一篇');
  ok(i >= 0 && j > i, '考材應在第一篇之前；實得 ' + JSON.stringify(r.lines));
});

t('preprocess 「第 2 篇」→「第二篇」（RE_PASS 是整行精確比對）', () => {
  const r = Md.preprocess('## 第 2 篇');
  ok(r.lines.indexOf('第二篇') >= 0, '實得 ' + JSON.stringify(r.lines));
});

t('preprocess ## 章節標題（非篇章）原樣保留', () => {
  const r = Md.preprocess('## 閱讀能力考材');
  ok(r.lines.indexOf('閱讀能力考材') >= 0);
});

/* ============================================================
   3. blocksFromMixed
   ============================================================ */
t('blocksFromMixed 產生 kind:p 與 kind:tr', () => {
  const blocks = Md.blocksFromMixed(['1. 題目（2分）', { cells: ['甲', '乙'] }]);
  eq(blocks[0].kind, 'p');
  eq(blocks[1].kind, 'tr');
  eq(blocks[1].cells.length, 2);
  eq(blocks[1].cells[0].visible, '甲');
  eq(blocks[1].cells[0].span, 1);
});

t('blocksFromMixed 表格列有 text / cells / options / letters', () => {
  const blocks = Md.blocksFromMixed([{ cells: ['A', '只有'] }]);
  const tr = blocks[0];
  eq(tr.text, 'A | 只有');
  ok(tr.cells[0].html.indexOf('A') >= 0, '儲存格應有 html');
  ok(Array.isArray(tr.letters) && Array.isArray(tr.options));
  eq(tr.cells.length, 2);
});

t('blocksFromMixed 同行選項被切開（列表型）', () => {
  const blocks = Md.blocksFromMixed(['A. 甲　B. 乙　C. 丙　D. 丁']);
  ok(blocks.length >= 4, '應切成 4 個選項段落；實得 ' + blocks.length);
  eq(blocks[0].text, 'A. 甲');
});

t('blocksFromMixed 表格格內的 A○ 會被認成記號與選項', () => {
  const b = Md.blocksFromMixed([{ cells: ['A○', 'B○', 'C○'] }]);
  eq(b[0].letters.join(','), 'A,B,C');
  eq(b[0].options.length, 3);
  eq(b[0].options.map(o => o.key).join(','), 'A,B,C');
  eq(b[0].cells[0].sym, 1);
});

t('blocksFromMixed 純符號格 A○ 不是 tick（tick 專指只有記號、沒有文字的格）', () => {
  const b = Md.blocksFromMixed([{ cells: ['A○'] }]);
  ok(!b[0].cells[0].tick, 'A○ 有字母，不該算 tick');
});

/* ============================================================
   4. parseText 端到端（最小案例）
   ============================================================ */
const MOCK = [
  '# 中二 閱讀能力考核 試卷一',
  '',
  '甲部：指定閱讀篇章（30%）',
  '',
  '## 第一篇',
  '',
  '岳陽樓記',
  '',
  '慶曆四年春，滕子京謫守巴陵郡。越明年，政通人和，百廢具興，乃重修岳陽樓，增其舊制，刻唐賢今人詩賦於其上。屬予作文以記之。',
  '',
  '予觀夫巴陵勝狀，在洞庭一湖。銜遠山，吞長江，浩浩湯湯，橫無際涯；朝暉夕陰，氣象萬千。此則岳陽樓之大觀也。',
  '',
  '－完－',
  '',
  '1. 作者寫作本文的原因是甚麼？（2分）',
  'A. 抒發自己被貶的憤懣',
  'B. 應朋友之託為岳陽樓作記',
  'C. 讚美洞庭湖的景色',
  'D. 記述重修岳陽樓的經過',
  '',
  '2. 試解釋以下句子中「屬」的意思。（2分）',
  '屬予作文以記之：＿＿＿＿＿＿',
  '',
  '3. 以下哪一項最適合形容作者在本文所抒發的懷抱？（2分）',
  'A. 只有',
  'B. 沒有',
  'C. 都有',
  'D. 以上皆非',
  '',
  '★ 1. B',
  '★ 3. A',
  '答案分析：本文為應滕子京之請而作。'
].join('\n');

const MOCK2 = [
  '# 中三 中國語文 閱讀能力考核',
  '',
  '## 第一篇',
  '',
  '這是一篇示範文章的內文，長度必須超過二十五個字，否則解析器不會把它當成正文段落處理，所以這裡刻意寫長一點。',
  '',
  '－完－',
  '',
  '4. 綜合全文，作者認為讀書最重要的原因是甚麼？（3分）',
  'A. 為了功名利祿　B. 為了明理修身　C. 為了取悅父母　D. 為了結交朋友',
  '',
  '5. 本文共有7個段落，分成四個部分，試指出各部分由哪些段落組成。（4分）',
  '',
  '6. 根據下表，填寫各典故所抒發的懷抱。（6分）',
  '| 典故 | 典故內容 | 所抒發的懷抱 |',
  '| --- | --- | --- |',
  '| 岳陽樓 | 重修岳陽樓 | ＿＿＿＿ |',
  '| 洞庭湖 | 銜遠山吞長江 | ＿＿＿＿ |',
  '',
  '★ 4. B'
].join('\n');

t('parseText 回傳標準結構', async () => { });
const p1 = Md.parseText(MOCK, { fileName: '中二試卷.md', mode: 'md' });
const p2 = Md.parseText(MOCK2, { fileName: '中三試卷.md', mode: 'md' });

const results = [];
Promise.all([p1, p2]).then(([r1, r2]) => {
  runAssertions(r1, r2);
}).catch(e => {
  console.log('❌ parseText 拋出例外：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

function runAssertions(r1, r2) {
  t('parseText 標題來自 # 標題', () => eq(r1.title, '中二 閱讀能力考核 試卷一'));
  t('parseText level 由標題推得', () => eq(r1.level, '中二'));
  t('parseText format = markdown', () => eq(r1.format, 'markdown'));
  t('parseText mode = text（重用 fromBlocks 路徑）', () => eq(r1.mode, 'text'));
  t('parseText 抓到 3 題', () => eq(r1.questions.length, 3, '實得 ' + JSON.stringify(r1.questions.map(q => q.no))));
  t('parseText 題號正確 1,2,3', () => eq(r1.questions.map(q => q.no).join(','), '1,2,3'));
  t('parseText 第1題是選擇題且有 4 個選項', () => {
    const q = r1.questions[0];
    eq(q.type, 'mcq', '第1題 type');
    eq(q.options.length, 4, '選項數；實得 ' + JSON.stringify(q.options));
  });
  t('parseText 第1題答案 = B（來自 ★ 行）', () => {
    const q = r1.questions[0];
    eq(q.answerKeys.join(','), 'B', 'answerKeys；實得 ' + JSON.stringify(q.answerKeys));
    eq(q.answer, 'B');
  });
  t('parseText 第3題答案 = A（來自 ★ 行）', () => {
    const q = r1.questions[2];
    eq(q.answerKeys.join(','), 'A');
  });
  t('parseText 第2題是文字題、有填空線索', () => {
    const q = r1.questions[1];
    ok(q.no === 2);
    ok(/＿|_/.test(q.stem + JSON.stringify(q.quotes || [])) || q.type === 'text', '第2題應為文字題');
  });
  t('parseText 答案分析 → explanation', () => {
    const any = r1.questions.some(q => /應滕子京之請/.test(q.explanation || ''));
    ok(any, '解析應被收進 explanation；實得 ' + JSON.stringify(r1.questions.map(q => q.explanation)));
  });
  t('parseText 文章被擷取（第一篇）', () => {
    ok(r1.passages.length >= 1, '應有文章；實得 ' + r1.passages.length);
    ok(r1.passages[0].paragraphs.join('').length > 50, '文章內文應夠長');
  });

  /* --- MOCK2 --- */
  t('parseText 表格題：第6題有 table.rows', () => {
    const q = r2.questions.filter(x => x.no === 6)[0];
    ok(q, '找不到第6題；實得 ' + JSON.stringify(r2.questions.map(x => x.no)));
    ok(q.table && q.table.rows && q.table.rows.length >= 3, '表格至少 3 列；實得 ' + JSON.stringify(q.table && q.table.rows));
    eq(q.table.rows[0].map(c => c.text).join('|'), '典故|典故內容|所抒發的懷抱');
  });
  t('parseText 分卷題被標記略過（第5題）', () => {
    const q = r2.questions.filter(x => x.no === 5)[0];
    ok(q, '找不到第5題');
    ok(q.skip, '段落劃分題應 skip；實得 ' + JSON.stringify(q));
  });
  t('parseText 同行選項被切開（第4題）', () => {
    const q = r2.questions.filter(x => x.no === 4)[0];
    eq(q.type, 'mcq');
    eq(q.options.length, 4, '實得 ' + JSON.stringify(q.options));
  });
  t('parseText 第4題答案 = B', () => {
    const q = r2.questions.filter(x => x.no === 4)[0];
    eq(q.answerKeys.join(','), 'B');
  });
  t('parseText markdown 統計', () => {
    ok(r2.markdown, '應有 markdown 統計');
    eq(r2.markdown.tableRows, 3, '表格列數（4 資料列＋1 表頭列 → 見下方明細）');
    eq(r2.markdown.answerLines, 1);
  });

  /* --- 其他模式 --- */
  t('parseText mode:txt 也吃純文字（無 # 標題）', () => {
    const r = Md.preprocess('中一 閱讀能力考核\n1. 題目？（2分）\nA. 甲\nB. 乙', { mode: 'txt' });
    ok(r.lines.some(l => /題目/.test(l)));
  });

  t('parseText 用檔案名當後備標題', () => {
    return Md.parseText('內文內容超過二十個字才不會被擋掉，這裡刻意寫長一點點。\n1. 問題？（2分）', { fileName: '我的試卷.md' })
      .then(r => { ok(r.title.length > 0, '應有標題；實得 ' + JSON.stringify(r.title)); });
  });

  t('parseText 太短要 reject', () => {
    return Md.parseText('太短', {}).then(() => { throw new Error('應該要 reject'); },
      (e) => { ok(/太短|20/.test(e.message), '錯誤訊息應說明太短；實得 ' + e.message); });
  });

  t('parseText 全空也要 reject', () => {
    return Md.parseText('', {}).then(() => { throw new Error('應該要 reject'); }, () => { });
  });

  Promise.resolve().then(() => {
    /* --- AI 模組（不連網）--- */
    finish();
  });
}

/* ---------- AI 模組純函式測試 ---------- */
function finish() {
  const AI = sandbox.window.RQ.ai;
  if (!AI) { console.log('⚠️  RQ.ai 未載入（測試略過）'); return report(); }

  t('AI 任務清單齊全', () => {
    ['review', 'answers', 'explain', 'structure', 'free'].forEach(k => ok(AI.TASKS[k], '缺 ' + k));
  });

  t('AI.extractJSON 抓 ```json 圍籬', () => {
    const r = AI.extractJSON('說明\n```json\n[{"no":1,"answer":"B"}]\n```\n結束');
    eq(r.length, 1); eq(r[0].answer, 'B');
  });

  t('AI.extractJSON 抓裸陣列', () => {
    const r = AI.extractJSON('前面文字 [{"no":3,"answer":"C"}] 後面');
    eq(r[0].no, 3);
  });

  t('AI.extractJSON 沒有 JSON 回 null', () => {
    eq(AI.extractJSON('沒有東西'), null);
  });

  const quiz = {
    title: 'T', questions: [
      { no: 1, stem: 'a', type: 'mcq', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }] },
      { no: 2, stem: 'b', type: 'text' },
      { no: 3, stem: 'c', type: 'text', answer: '舊答案' }
    ]
  };

  t('AI.applyPatches 選擇題答案寫入 answerKeys', () => {
    const r = AI.applyPatches(quiz, [{ no: 1, answer: 'B' }]);
    eq(r.applied, 1);
    eq(r.questions[0].answerKeys.join(','), 'B');
    eq(r.questions[0].answer, 'B');
  });

  t('AI.applyPatches 文字題答案原樣寫入', () => {
    const r = AI.applyPatches(quiz, [{ no: 2, answer: '承先啟後，帶出下文' }]);
    eq(r.questions[1].answer, '承先啟後，帶出下文');
  });

  t('AI.applyPatches explanation 併入', () => {
    const r = AI.applyPatches(quiz, [{ no: 3, explanation: '因為…' }]);
    eq(r.questions[2].explanation, '因為…');
  });

  t('AI.applyPatches 不覆蓋既有答案（只有 explanation 時）', () => {
    const r = AI.applyPatches(quiz, [{ no: 3, explanation: 'E' }]);
    eq(r.questions[2].answer, '舊答案');
  });

  t('AI.applyPatches 找不到題號 → skipped', () => {
    const r = AI.applyPatches(quiz, [{ no: 99, answer: 'X' }]);
    eq(r.applied, 0); eq(r.skipped, 1);
  });

  t('AI.applyPatches 不修改原物件', () => {
    AI.applyPatches(quiz, [{ no: 1, answer: 'B' }]);
    ok(!quiz.questions[0].answer, '原本的 quiz 不該被改；實得 ' + JSON.stringify(quiz.questions[0]));
  });

  t('AI.packQuiz 精簡欄位', () => {
    const p = AI.packQuiz(quiz);
    eq(p.questions.length, 3);
    ok(p.questions[0].options.length === 2);
    ok(!('raw' in p.questions[0]), '不該帶 raw');
  });

  t('AI.packQuiz 截斷超長文章', () => {
    const big = { title: 'X', passages: [{ title: 'p', paragraphs: [new Array(20000).join('字')] }], questions: [] };
    const p = AI.packQuiz(big);
    ok(p.passages[0].text.length < 7000, '文章應被截斷；實得 ' + p.passages[0].text.length);
  });

  t('AI.route 未設定時 ready=false', () => {
    const r = AI.route();
    ok(!r.ready);
  });

  t('AI.isReady 預設 false', () => ok(!AI.isReady()));

  t('AI.chat 未啟用要 reject 且說明清楚', () => {
    return AI.chat([{ role: 'user', content: 'hi' }]).then(
      () => { throw new Error('應該要 reject'); },
      (e) => { ok(/尚未啟用/.test(e.message), '實得 ' + e.message); });
  });

  /* ============================================================
     AI 設定（store.js 的 ai 欄位 + route()）
     ============================================================ */
  const S = sandbox.window.RQ.settings;

  t('settings 有 ai 預設值，且深層 merge 不會被清掉', () => {
    ok(S.get().ai, 'settings.get() 應有 ai 物件');
    S.set({ ai: { provider: 'gemini', apiKey: 'K1' } });
    eq(S.get().ai.provider, 'gemini');
    eq(S.get().ai.apiKey, 'K1');
    /* 只改一個欄位時，其他欄位要保留 */
    S.set({ ai: { model: 'gemini-2.0-flash' } });
    eq(S.get().ai.provider, 'gemini', 'provider 不該被清掉');
    eq(S.get().ai.apiKey, 'K1', 'apiKey 不該被清掉');
    eq(S.get().ai.model, 'gemini-2.0-flash');
  });

  t('AI.cfg() 讀得到剛存的設定', () => {
    const c = AI.cfg();
    eq(c.provider, 'gemini');
    eq(c.apiKey, 'K1');
    eq(c.keyQuery, 'key', '未設定時應回預設值');
  });

  t('AI.route() 有金鑰後 ready=true', () => {
    const r = AI.route();
    ok(r.ready, '應為 true，why=' + r.why);
    eq(r.kind, 'gemini');
  });

  t('AI.route() 選 direct 但沒金鑰 → ready=false 且有原因', () => {
    S.set({ ai: { provider: 'direct', apiKey: '' } });
    const r = AI.route();
    ok(!r.ready);
    ok(/金鑰/.test(r.why), '應提示缺金鑰；實得 ' + r.why);
  });

  t('AI.route() 選 hook 但沒 postUrl → ready=false', () => {
    S.set({ ai: { provider: 'hook', apiKey: '' } });
    const r = AI.route();
    ok(!r.ready);
    ok(/postUrl/.test(r.why), '應提示缺 postUrl；實得 ' + r.why);
  });

  t('設了 hook.postUrl 後 hook 通道 ready=true', () => {
    S.set({ hook: { postUrl: 'https://script.google.com/macros/s/X/exec' } });
    const r = AI.route();
    ok(r.ready, 'why=' + r.why);
    eq(r.kind, 'hook');
  });

  t('enabled=false 時 isReady() 為 false（不管通道通不通）', () => {
    S.set({ ai: { enabled: false } });
    ok(!AI.isReady());
    S.set({ ai: { enabled: true } });
    ok(AI.isReady(), '啟用後應為 true');
  });

  t('清除金鑰不會影響 provider 以外的設定', () => {
    S.set({ ai: { provider: 'direct', apiKey: 'K2', model: 'gpt-4o-mini' } });
    AI.save({ apiKey: '' });
    eq(AI.cfg().model, 'gpt-4o-mini');
    eq(AI.cfg().apiKey, '', '空字串會被 cfg() 還原成預設（也是空）');
    ok(!AI.route().ready, '沒有金鑰就不該 ready');
  });

  /* ---- 通道：不打網路，只驗證請求長相 ---- */
  const calls = [];
  sandbox.fetch = function (url, opt) {
    calls.push({ url: url, opt: opt, body: opt && opt.body ? JSON.parse(opt.body) : null });
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: '回覆內容' } }],
        usage: { total_tokens: 42 }
      }))
    });
  };

  t('direct 通道打 /chat/completions 並帶 Bearer', () => {
    S.set({ ai: { enabled: true, provider: 'direct', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'K3' } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then((out) => {
      eq(calls.length, 1);
      eq(calls[0].url, 'https://api.openai.com/v1/chat/completions');
      eq(calls[0].opt.headers.Authorization, 'Bearer K3');
      eq(calls[0].body.model, 'gpt-4o-mini');
      eq(out.text, '回覆內容');
    });
  });

  t('direct 端點沒有 /v1 時會自動補上', () => {
    calls.length = 0;
    S.set({ ai: { endpoint: 'https://api.deepseek.com' } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then(() => {
      eq(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    });
  });

  t('gemini 通道金鑰放 query string、system 轉 systemInstruction', () => {
    calls.length = 0;
    S.set({ ai: { provider: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', apiKey: 'GK' } });
    return AI.chat([
      { role: 'system', content: '你是老師' },
      { role: 'user', content: 'hi' }
    ]).then(() => {
      has(calls[0].url, 'models/gemini-2.0-flash:generateContent');
      has(calls[0].url, 'key=GK');
      eq(calls[0].body.systemInstruction.parts[0].text, '你是老師');
      eq(calls[0].body.contents.length, 1, 'system 不該出現在 contents');
    });
  });

  t('hook 通道用 text/plain（避免 Apps Script preflight）且帶 action:ai', () => {
    calls.length = 0;
    S.set({ ai: { provider: 'hook', apiKey: '' }, hook: { postUrl: 'https://script.google.com/macros/s/X/exec', key: 'WK' } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then(() => {
      eq(calls[0].url, 'https://script.google.com/macros/s/X/exec');
      eq(calls[0].opt.headers['Content-Type'], 'text/plain;charset=utf-8');
      eq(calls[0].body.action, 'ai');
      eq(calls[0].body.key, 'WK');
    });
  });

  t('hook 回傳 {text} 時解析正確', () => {
    calls.length = 0;
    sandbox.fetch = function (url, opt) {
      calls.push({ url: url, opt: opt });
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true, text: '代理回覆', model: 'm' }))
      });
    };
    return AI.chat([{ role: 'user', content: 'hi' }]).then((out) => {
      eq(out.text, '代理回覆');
    });
  });

  t('AI.ping() 成功時回 {ok:true}', () => {
    return AI.ping().then((r) => {
      ok(r.ok === true);
      eq(r.text, '代理回覆', 'ping 會把回覆截短');
    });
  });

  t('AI.run() 回傳帶 task 與 label', () => {
    return AI.run('review', quiz, {}).then((out) => {
      eq(out.task, 'review');
      ok(out.label && out.label.indexOf('體檢') >= 0, '實得 ' + out.label);
    });
  });

  t('AI.run() 的 system 提示真的送出（不是空字串）', () => {
    calls.length = 0;
    return AI.run('answers', quiz, {}).then(() => {
      const body = JSON.parse(calls[0].opt.body);
      ok(body.messages[0].role === 'system' && body.messages[0].content.length > 10);
      has(body.messages[1].content, '"no": 1', 'user 訊息應含題目 JSON');
    });
  });

  t('AI.run() 只有 hook 時也能跑（provider=hook、viaHook 不必開）', () => {
    calls.length = 0;
    S.set({ ai: { provider: 'hook', apiKey: '' } });
    return AI.run('free', quiz, { question: '這卷難嗎' }).then(() => {
      has(calls[0].opt.body, 'ai');
    });
  });

  /* ============================================================
     Gemini 通道：自動挑模型 / 自動換掉已下架的模型
     （Google 會淘汰舊模型，寫死型號一定有一天會壞）
     ============================================================ */
  const GKEY = 'AIzaTESTKEY_abcdefghij';
  const _gemClear = () => AI.clearModelCache();
  function geminiFetch(list, send) {
    return function (url, opt) {
      calls.push({ url: url, opt: opt });
      if (/\/models\?/.test(url)) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            models: (typeof list === 'function' ? list() : list).map(id => ({
              name: 'models/' + id,
              supportedGenerationMethods: ['generateContent', 'countTokens']
            }))
          }))
        });
      }
      return send(url, opt);
    };
  }
  const okSend = (model) => (url) => Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify({
      model: model, candidates: [{ content: { parts: [{ text: '好' }] } }],
      usageMetadata: { totalTokenCount: 7 }
    }))
  });
  function notFound() {
    return Promise.resolve({
      ok: false, status: 404,
      text: () => Promise.resolve(JSON.stringify({
        error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-2.0-flash is not found for API version v1beta' }
      }))
    });
  }

  t('Gemini：會先問 ListModels，再挑偏好清單中最新可用的模型', () => {
    calls.length = 0;
    /* 清單裡沒有 flash-latest / 3-preview，但有 2.5-flash → 應挑 2.5-flash */
    sandbox.fetch = geminiFetch(['gemini-2.0-flash', 'gemini-2.5-flash', 'text-embedding-004'], okSend('gemini-2.5-flash'));
    _gemClear();
    S.set({ ai: { enabled: true, provider: 'gemini', endpoint: '', model: '', apiKey: GKEY } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then((out) => {
      eq(out.model, 'gemini-2.5-flash');
      /* 第一次是 ListModels，第二次才是 generateContent */
      has(calls[0].url, '/models?');
      has(calls[1].url, 'models/gemini-2.5-flash:generateContent');
    });
  });

  t('Gemini：偏好清單優先選 gemini-flash-latest（存在就用最新的）', () => {
    calls.length = 0;
    sandbox.fetch = geminiFetch(['gemini-2.5-flash', 'gemini-flash-latest'], okSend('gemini-flash-latest'));
    _gemClear();
    S.set({ ai: { model: '', apiKey: GKEY } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then((out) => {
      eq(out.model, 'gemini-flash-latest');
    });
  });

  t('Gemini：老師自己填的型號若在清單中，會被尊重', () => {
    calls.length = 0;
    sandbox.fetch = geminiFetch(['gemini-2.5-flash', 'gemini-2.5-flash-lite'], okSend('gemini-2.5-flash-lite'));
    _gemClear();
    S.set({ ai: { model: 'gemini-2.5-flash-lite', apiKey: GKEY } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then((out) => {
      eq(out.model, 'gemini-2.5-flash-lite');
      has(calls[1].url, 'models/gemini-2.5-flash-lite');
    });
  });

  t('🔴 Gemini：型號已下架（404）→ 自動改用清單裡最新可用的', () => {
    calls.length = 0;
    let first = true;
    sandbox.fetch = geminiFetch(['gemini-2.5-flash'],
      (url) => {
        /* 第一次用老師填的舊型號 → 404；之後成功 */
        if (first) { first = false; return notFound(); }
        return okSend('gemini-2.5-flash')(url);
      });
    _gemClear();
    S.set({ ai: { model: 'gemini-2.0-flash', apiKey: GKEY } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then((out) => {
      eq(out.model, 'gemini-2.5-flash', '應自動換成清單中可用的');
      eq(out.autoSwitchedFrom, 'gemini-2.0-flash', '要留下「原本用哪個」的痕跡');
      eq(calls.length, 3, 'ListModels + 失敗一次 + 成功一次');
    });
  });

  t('Gemini：ListModels 失敗（金鑰問題）→ 不吞錯，把真正的原因丟出來', () => {
    calls.length = 0;
    sandbox.fetch = function (url, opt) {
      calls.push({ url: url, opt: opt });
      if (/\/models\?/.test(url)) {
        return Promise.resolve({
          ok: false, status: 400,
          text: () => Promise.resolve(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }))
        });
      }
      /* 清單讀不到時還是要照著老師填的型號送一次，讓真正的錯誤浮出來 */
      return Promise.resolve({
        ok: false, status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }))
      });
    };
    _gemClear();
    S.set({ ai: { model: 'gemini-2.5-flash', apiKey: 'BAD' } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then(
      () => { throw new Error('應該要 reject'); },
      (e) => { has(e.message, 'API key not valid', '錯誤訊息要原樣帶出'); });
  });

  t('Gemini：4096 以上回應被截斷時，finishReason 會出現在錯誤訊息裡', () => {
    calls.length = 0;
    sandbox.fetch = geminiFetch(['gemini-2.5-flash'], (url) => Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }]
      }))
    }));
    _gemClear();
    S.set({ ai: { model: '', apiKey: GKEY } });
    return AI.chat([{ role: 'user', content: 'hi' }]).then(
      () => { throw new Error('應該要 reject'); },
      (e) => { has(e.message, 'MAX_TOKENS', '要告訴老師是被長度截斷，不是模型壞了'); });
  });

  t('AI.listModels() 回傳可用清單與建議型號（過濾掉 embedding／imagen）', () => {
    calls.length = 0;
    sandbox.fetch = geminiFetch(
      ['text-embedding-004', 'imagen-3.0-generate', 'gemini-2.5-flash', 'gemini-2.5-pro'], okSend('x'));
    _gemClear();
    S.set({ ai: { model: '', apiKey: GKEY } });
    return AI.listModels().then((r) => {
      ok(r.all.indexOf('text-embedding-004') < 0, 'embedding 應被濾掉');
      ok(r.all.indexOf('imagen-3.0-generate') < 0, 'imagen 應被濾掉');
      ok(r.preferred.indexOf('gemini-2.5-flash') >= 0);
      eq(r.suggested, 'gemini-2.5-flash');
    });
  });

  t('AI.listModels() 沒金鑰時直接 reject', () => {
    return AI.listModels({ apiKey: '' }).then(
      () => { throw new Error('應該要 reject'); },
      (e) => { has(e.message, '金鑰'); });
  });

  t('Gemini 端點預設值沒被改壞（仍指向 generativelanguage）', () => {
    has(AI.PROVIDERS.gemini.endpoint, 'generativelanguage.googleapis.com');
    has(AI.PROVIDERS.gemini.endpoint, 'v1beta');
  });

  report();
}
function report() {
  console.log('');
  console.log('通過 ' + pass + '／' + (pass + fail));
  if (failures.length) {
    console.log('\n❌ 失敗項目：');
    failures.forEach(f => console.log('  · ' + f));
  } else {
    console.log('✅ 全部通過');
  }
  process.exit(fail ? 1 : 0);
}
