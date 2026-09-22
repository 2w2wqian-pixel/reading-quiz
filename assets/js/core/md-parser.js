/* ============================================================
   md-parser.js — 把 Markdown／純文字「考卷」轉成與 docx 完全相同的
   出題管線（blocksFromLines → fromBlocks），用來解決掃描 PDF
   沒有文字層、無法抽字的問題：
   老師可先把試卷打成 / OCR 成 Markdown 或純文字，再上傳。

   支援的寫法（全部選填，愈多標記 = 解析愈準）：

     # 2020-DSE 中國語文 卷一 閱讀能力            ← 標題（第一個 # 或第一行）
     ===== Page 2 =====                           ← 分頁標記，會被忽略
     ## 第一篇                                    ← 篇章（等同「第一篇」）
     甲部：指定閱讀篇章（30%）                     ← 分卷
     1. 以下哪一項……？（2分）                      ← 題目
     A. 只有　B. 沒有　C. 都有　D. 以上皆非        ← 選項（同行或分行皆可）
     [選擇方格：A B C D]                           ← 作答格，會被忽略
     【註釋】                                      ← 區段標記
     | 典故 | 典故內容 | 所抒發的懷抱 |            ← Markdown 表格 → 表格題
     | --- | --- | --- |
     | 甲 | …… | …… |
     6. 試解釋以下句子中「－」的意思。（4分）        ← 課文填空
     第一段：＿＿＿＿＿＿＿＿                      ← 底線 → 學生輸入框
     答案分析：……                                  ← 解析
     －完－                                        ← 文章結束
     ═══ 教師版 ═══                                ← 教師版開始（答案＝紅字／★行）
     ★ 答案：B                                     ← 教師版答案行（★／✔／【答案】）
     **答案：B**                                   ← 粗體答案行亦可

   設計原則：**改寫成「乾淨的純文字行」再交給既有解析器**，
   不在這裡重新實作題號偵測／選項抽取／分卷切換，
   確保 Markdown 來源與 .docx、PDF 來源的輸出一模一樣。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util;

  /* ---------- 正則 ---------- */
  var RE_PAGE   = /^[=\u2500\u2501\-–—﹦═\s]{3,}$|^={3,}\s*Page\s*\d+/i;
  var RE_PAGEN  = /^={2,}\s*(?:Page|頁)\s*(\d+)/i;
  var RE_FENCE  = /^\s*(```|~~~)/;
  var RE_HR     = /^\s*(?:[-*_]\s*){3,}$/;
  var RE_HEAD   = /^\s{0,3}(#{1,6})\s*(.*)$/;
  var RE_QUOTE  = /^\s{0,3}>\s?(.*)$/;
  var RE_TABLE  = /^\s*\|.*\|\s*$/;
  var RE_TSEP   = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
  var RE_LIST   = /^(\s*)([-*+]|\d{1,2}[.)])\s+(.*)$/;
  var RE_TICK   = /^\s*(?:[★☆✔✓√☑]|\[[xX]\]|（正確答案）|\(正確答案\))\s*/;
  var RE_ANS    = /^\s*[【\[]\s*(?:正確答案|參考答案|答案)\s*[】\]]\s*[:：]?\s*/;
  var RE_ANSLBL = /^\s*(?:正確答案|參考答案|答案)\s*[:：]\s*/;
  var RE_VER    = /^[=\u2500\u2501\-–—﹦═\s]*[^\n]{0,60}?(?:教師版|答案版|參考答案|Suggested\s*Answers)[^\n]{0,60}[=\u2500\u2501\-–—﹦═\s]*$/i;
  var RE_CELLBLANK = /^\s*[_＿]{2,}\s*$/;

  /* ---------- 小工具 ---------- */

  var CND = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  /** 1 / 2 / 一 / 二 → 一 / 二（解析器的「第X篇」是中文數字） */
  function toCN(v) {
    var s = U.trim(v);
    if (/^[一二三四五六七八九十]+$/.test(s)) return s;
    var n = parseInt(s, 10);
    if (!n || n < 1 || n > 99) return '';
    if (n <= 10) return CND[n];
    if (n < 20) return '十' + CND[n - 10];
    if (n % 10 === 0) return CND[Math.floor(n / 10)] + '十';
    return CND[Math.floor(n / 10)] + '十' + CND[n % 10];
  }

  /** 去掉行內 Markdown 標記（粗體／斜體／行內程式碼／連結），保留純文字 */
  function stripInline(s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/`([^`]+)`/g, '$1');                     /* `code` */
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');               /* **bold** */
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2'); /* *em* */
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1$2');  /* _em_ */
    t = t.replace(/~~([^~]+)~~/g, '$1');                   /* ~~del~~ */
    t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');        /* [text](url) */
    t = t.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1');
    t = t.replace(/<br\s*\/?>/gi, ' ');
    t = t.replace(/<\/?[a-zA-Z][^>]*>/g, '');              /* 殘留的 HTML 標籤 */
    t = t.replace(/&nbsp;/gi, ' ');
    t = t.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
    return U.trim(t);
  }

  /* `**…**` 的 span 抓取（用來判斷整行是否為粗體＝答案候選） */
  function boldSpans(line) {
    var out = [], re = /\*\*([^*]+)\*\*/g, m;
    while ((m = re.exec(line))) out.push({ text: m[1], at: m.index, len: m[0].length });
    return out;
  }

  /** 依「定界字元」切表格列（定界字元可能被跳脫成 \|） */
  function splitRow(line) {
    var t = String(line).replace(/^\s*\|/, '');
    t = t.replace(/\|\s*$/, '');
    var cells = [], cur = '';
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '|') { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells.map(function (x) { return stripInline(x); });
  }

  /** 是否為值區段（題目／選項／答案）—— 出現在文件前 6 成前，長得像即可 */
  function looksLikeValue(t) {
    if (!t) return false;
    if (t.indexOf('（') >= 0 && /分[）)]/.test(t)) return true;
    if (/[？?]$/.test(t)) return true;
    if (/^[A-H][.、)]\s*\S/.test(t)) return true;
    if (/^第[一二三四五六七八九十\d]+[篇部]/.test(t)) return true;
    if (/_{2,}|＿{2,}/.test(t)) return true;
    if (t.length >= 20) return true;
    return false;
  }

  /** 整行包在粗體裡／含有答案標記 → 視為教師版答案行 */
  function isAnswerLine(line, fullText) {
    var t = U.trim(String(line));
    if (!t) return false;
    if (RE_TICK.test(t) || RE_ANS.test(t) || RE_ANSLBL.test(t)) return true;
    if (/教師版|答案版/.test(t)) return true;
    var spans = boldSpans(t);
    if (!spans.length) return false;
    /* 粗體幾乎佔滿整行 → 強信號 */
    var covered = spans.reduce(function (a, s) { return a + s.len; }, 0);
    if (covered / t.length > 0.6) return true;
    /* 保守規則：只在「文件裡本來就有教師版區段，或明顯是註腳式的答案行」才採用 */
    if (!(fullText && /教師版|答案版/.test(fullText))) return false;
    var bare = stripInline(t);
    if (spans.length === 1 && bare === U.trim(spans[0].text)) return true;
    if (/^[A-H]$/.test(bare) || /^[A-H][.、)）]/.test(bare)) return true;
    if (bare.length <= 30 && t.indexOf(spans[0].text) === spans[0].at - 2) return true;
    return false;
  }

  /* ============================================================
     主要前處理：文字 → 乾淨的行陣列
     ============================================================ */
  /**
   * @param {string} raw  Markdown／純文字全文
   * @param {Object} opt  {mode:'md'|'txt', answerColor:'FF0000'}
   * @returns {{lines:Array, meta:Object}}
   */
  function preprocess(raw, opt) {
    opt = opt || {};
    var isMd = opt.mode !== 'txt';
    var text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    text = text.replace(/^\uFEFF/, '');

    var srcLines = text.split('\n');
    var out = [];       /* 輸出：字串（原樣移交給 blocksFromLines）或 {cells:[…]} 表格列 */
    var meta = {
      title: '', titleFromHeading: false,
      pageCount: 0, headings: [], droppedAnsLines: 0,
      tableRows: 0, sectionHint: false, teacherHint: false,
      blanks: 0, mode: isMd ? 'markdown' : 'text'
    };

    var inCode = false, inTable = false, seenAny = false;
    /* 前 45% 的行才做「粗體＝答案」的保守判斷（避免把文章裡的引號粗體當成答案） */
    var guard = Math.max(12, Math.floor(srcLines.length * 0.45));

    for (var i = 0; i < srcLines.length; i++) {
      var raw0 = srcLines[i];
      var line = U.trim(raw0);

      /* --- 程式碼圍籬：整段略過（避免把示例當成題目） --- */
      if (RE_FENCE.test(line)) { inCode = !inCode; continue; }
      if (inCode) continue;

      /* --- 空行 → 保留（分段用） --- */
      if (line === '') {
        if (inTable) { inTable = false; }
        out.push('');
        continue;
      }

      /* --- 分頁標記（===== Page N =====、整行分隔線） --- */
      if (RE_PAGE.test(line) && !RE_TABLE.test(line)) {
        var pm = line.match(RE_PAGEN);
        if (pm) { meta.pageCount = Math.max(meta.pageCount, parseInt(pm[1], 10) || 0); }
        out.push('');
        continue;
      }
      if (RE_HR.test(line)) { out.push(''); continue; }

      /* --- 水平分隔線／頁框：只剩符號的行 --- */
      if (/^[\s\u3000]*[=﹦═\-–—\u2500\u2501]{3,}[\s\u3000]*$/.test(line)) { out.push(''); continue; }

      /* --- 引線（> 引文）→ 去掉引線後照常處理 --- */
      var qm = line.match(RE_QUOTE);
      var quoted = false;
      if (qm) { line = U.trim(qm[1]); quoted = true; if (!line) { out.push(''); continue; } }

      /* --- 作答方格標記 → 轉成選項記號 ---
         例如「[選擇方格：A B C D]」「（作答方格：A）」「選擇方格 A B C D」
         這些在文字版裡只是紙本的方格位置。既有的選項抽取需要「字母 + 文字」，
         所以這裡補上「選項 A」這種佔位文字，讓學生真的可以線上作答。
         ⚠ 一定要用「一行一個選項」的形式：`blocksFromLines` 內部的
         `splitOptionLine` 只認「A. x」後面有空白的形式，把它們寫在同一行
         反而會切出空的選項而全部消失。 */
      var gm = line.match(/^[\s【\[（(]*\s*(?:選擇方格|作答方格|答案方格|選擇題方格)\s*[:：]?\s*([A-H](?:[\s,、／\/]*[A-H])*)/i);
      if (gm) {
        var keys = gm[1].match(/[A-H]/g) || [];
        if (keys.length >= 2) {
          keys.forEach(function (k) { out.push(k + '. 選項' + k); });
          meta.gridKeys = (meta.gridKeys || []).concat(keys);
          continue;
        }
      }

      /* --- Markdown 表格 --- */
      if (isMd && RE_TABLE.test(line)) {
        if (RE_TSEP.test(line)) continue;                  /* |---|---| 分隔列略過 */
        var cells = splitRow(line);
        if (cells.length) { out.push({ cells: cells }); meta.tableRows++; inTable = true; continue; }
      }
      inTable = false;

      /* --- 標題（# / ## …） --- */
      var hm = line.match(RE_HEAD);
      if (hm) {
        var htext = stripInline(hm[2]);
        var lv = hm[1].length;
        if (!htext) continue;
        if (lv === 1) {
          meta.headings.push(htext);
          if (!meta.title) { meta.title = htext; meta.titleFromHeading = true; }
          out.push(htext);
          continue;
        }
        /* ## 第二篇 → 一定要還原成「第二篇」（解析器的 RE_PASS 是整行精確比對，
           多加「第」以外的字或改成「第 2 篇」都會抓不到，文章就會整段消失） */
        var pnum = htext.match(/^第\s*([0-9一二三四五六七八九十]+)\s*(?:篇|章|則|部分|part)\s*$/i);
        if (pnum) {
          var cnd = toCN(pnum[1]);
          if (cnd) { meta.headings.push(htext); out.push('第' + cnd + '篇'); continue; }
        }
        /* ## 閱讀能力考材 / ## 教師版 … → 原樣保留，交給既有的區段偵測 */
        meta.headings.push(htext);
        out.push(htext);
        continue;
      }

      /* --- 教師版答案行判定 --- */
      if (i < guard || meta.teacherHint) {
        if (RE_VER.test(line) && /教\s*師\s*版|答案版|Suggested\s*Answers/i.test(line)) {
          meta.teacherHint = true;
          out.push(stripInline(line) || '教師版');
          continue;
        }
      }
      if (isAnswerLine(line, text) && !looksLikeQuestionOrStem(line)) {
        /* 變成「★ 答案：…」形式；★ 不是常見字元，會被 RE_QNO 擋掉、也不會被當題號 */
        var bare = stripInline(line.replace(RE_TICK, '').replace(RE_ANS, '').replace(RE_ANSLBL, ''));
        if (bare) { out.push('★ ' + bare); meta.droppedAnsLines++; }
        else { out.push('  ' + U.trim(stripInline(line))); }
        continue;
      }

      /* --- 清單項目 --- */
      var lm = line.match(RE_LIST);
      if (lm) {
        var body = stripInline(lm[3]);
        if (!body) continue;
        /* 「1. 題目」→ 保留題號；「- 選項」→ 去記號 */
        if (/^\d{1,2}[.)]$/.test(lm[2])) {
          out.push(lm[2].replace(/[.)]$/, '') + '. ' + body);
        } else {
          out.push(body);
        }
        continue;
      }

      /* --- 一般段落 --- */
      out.push(stripInline(line));

      /* --- 標題後備：第一行看起來不像題目 → 當標題 --- */
      if (!seenAny && !meta.title && looksLikeTitle(line)) {
        meta.title = stripInline(line);
      }
      if (!seenAny) seenAny = true;
    }

    /* ---- 區段提示 ---- */
    meta.sectionHint = out.some(function (l) {
      return typeof l === 'string' && /^[\s\u3000]*[甲乙丙丁戊己庚辛壬癸][\s\u3000]*部/.test(l);
    });

    /* ---- 補上「閱讀能力考材」標記 ----
       解析器只在「閱讀能力考材」之後才收文章。OCR／老師手打的文字版
       常常沒有這一行（它在原卷只是個版面標題），少了它整篇文章就會不見。
       若文字裡已有「第X篇」卻沒有「閱讀能力考材」→ 在第一篇之前補一行。 */
    if (!out.some(function (l) { return typeof l === 'string' && /閱\s*讀\s*能\s*力\s*考\s*材/.test(l); })) {
      var passAt = -1;
      for (var k = 0; k < out.length; k++) {
        var ln = out[k];
        if (typeof ln === 'string' && ln.length <= 20 && /^[\s\u3000]*第[一二三四五六七八九十\d]+\s*篇/.test(ln)) { passAt = k; break; }
      }
      /* 沒有任何「第X篇」→ 找「－完－」的位置，文章就在它前面 */
      if (passAt < 0) {
        for (var k2 = 0; k2 < out.length; k2++) {
          var l2 = out[k2];
          if (typeof l2 === 'string' && /^[\s\u3000]*[—–－]\s*完\s*[—–－]/.test(l2)) { passAt = k2; break; }
        }
        if (passAt >= 0) {
          /* 往前推到文章的第一個長段落 */
          while (passAt > 0 && !(typeof out[passAt - 1] === 'string' && out[passAt - 1].length >= 25)) passAt--;
        }
      }
      if (passAt >= 0) {
        out.splice(passAt, 0, '閱讀能力考材');
        meta.synthMat = true;
      }
    }

    return { lines: out, meta: meta };
  }

  /** 題目／選項行不該被當成答案行（避免把題幹粗體吃掉） */
  function looksLikeQuestionOrStem(line) {
    var t = stripInline(line);
    if (/^[\s\u3000]*\d{1,2}[\s\u3000]*\S/.test(t) && (/分[）)]/.test(t) || /[？?]/.test(t))) return true;
    if (/^[A-H][.、)]\s*\S/.test(t)) return true;
    return false;
  }

  /** 看起來像標題：短、沒有題號、沒有選項記號、不含分數 */
  function looksLikeTitle(line) {
    var t = stripInline(line);
    if (!t || t.length > 60) return false;
    if (/^[\s\u3000]*\d/.test(t)) return false;
    if (/[？?]$/.test(t)) return false;
    if (/分[）)]/.test(t)) return false;
    return true;
  }

  /* ============================================================
     lines（字串／{cells} 混用）→ 解析器 block
     ============================================================ */
  /** 把 {cells:[…]} 轉成 kind:'tr' 的 block */
  function rowBlockFromCells(cells) {
    var cs = (cells || []).map(function (x) {
      var t = U.trim(x);
      /* 讓儲存格也能用既有的記號抽取：Markdown 表格裡寫「A○」或「A. 甲」
         時，會與 docx／PDF 來源一樣被認出是選項／勾選記號。 */
      var re = /(^|[\s\u3000])?([A-H])\s*[○●✓✔√]\s*/g, m;
      var letters = [];
      while ((m = re.exec(t))) letters.push(m[2]);
      var opts = [];
      var pairs = t.match(/([A-H])\s*[○●]\s*([^A-H○●]*)/g) || [];
      pairs.forEach(function (p) {
        var mm = p.match(/^([A-H])\s*[○●]\s*/);
        if (mm) opts.push({ key: mm[1], text: U.trim(p.slice(mm[0].length)), red: false });
      });
      var tick = /^\s*[○●✓✔√]\s*$/.test(t);
      return {
        text: t, html: U.esc(t), visible: t,
        red: false, sym: letters.length, tick: tick,
        letters: letters, span: 1, vmerge: null, options: opts
      };
    });
    return {
      kind: 'tr', node: null, cells: cs,
      text: cs.map(function (c) { return c.text; }).join(' | '),
      red: false,
      letters: cs.reduce(function (a, c) { return a.concat(c.letters); }, []),
      options: cs.reduce(function (a, c) { return a.concat(c.options); }, [])
    };
  }

  /**
   * 把前處理後的行陣列轉成 block 陣列。
   * 字串行交給 `Docx.blocksFromLines`（完全重用既有邏輯）；
   * 表格列由這裡自行組成 kind:'tr'。
   */
  function blocksFromMixed(lines, opt) {
    opt = opt || {};
    var D = RQ.docx;
    var out = [];
    var buf = [];
    var flush = function () {
      if (!buf.length) return;
      var bs = D.blocksFromLines(buf, { red: !!opt.red });
      for (var k = 0; k < bs.length; k++) out.push(bs[k]);
      buf = [];
    };
    (lines || []).forEach(function (one) {
      if (one && typeof one === 'object' && one.cells) {
        flush();
        out.push(rowBlockFromCells(one.cells));
      } else {
        buf.push(String(one == null ? '' : one));
      }
    });
    flush();
    return out;
  }

  /* ============================================================
     對外 API
     ============================================================ */
  var Md = {
    preprocess: preprocess,
    stripInline: stripInline,
    blocksFromMixed: blocksFromMixed,

    /**
     * 把純文字／Markdown 全文解析成試卷。
     * @param {string|File} input 全文或檔案
     * @param {Object} opt {fileName, answerColor, lang, mode:'md'|'txt', title, noAnswers}
     * @returns {Promise} 與 Docx.parse 相同的結構（外加 mode 與 markdown 統計）
     */
    parseText: function (input, opt) {
      opt = opt || {};
      var fileName = opt.fileName || '';
      var color = opt.answerColor || 'FF0000';

      return Promise.resolve()
        .then(function () {
          if (typeof File !== 'undefined' && input instanceof File) return U.readFileAsText(input);
          if (input instanceof Blob) return U.readFileAsText(input);
          return input;
        })
        .then(function (raw) {
          var txt = String(raw == null ? '' : raw);
          if (U.trim(txt).length < 20) throw new Error('內容太短（少於 20 字），可能不是考卷文字檔');

          var isMd = opt.mode ? (opt.mode !== 'txt') : /\.(md|markdown|txt)$/i.test(fileName)
            ? !/\.txt$/i.test(fileName) : true;

          var pre = preprocess(txt, { mode: isMd ? 'md' : 'txt', answerColor: color });
          var lines = pre.lines, meta = pre.meta;

          var blocks = blocksFromMixed(lines, { red: false });

          /* 教師版答案行（★／粗體）→ 拆成獨立的「紅字」block，
             讓既有的 collectQuestions(isTeacher) 邏輯直接把它們當答案 */
          var answerLines = [];
          blocks.forEach(function (b) {
            if (b.kind === 'p' && /^[★☆✔✓√☑]\s*/.test(b.text)) {
              answerLines.push(U.trim(b.text.replace(/^[★☆✔✓√☑]\s*/, '')));
            }
          });

          var res = RQ.docx.fromBlocks(blocks, [], {
            fileName: fileName,
            answerColor: color,
            lang: opt.lang,
            mode: 'text'
          });

          /* 標題：老師指定 > 檔案標題（# ／首行）> 解析器猜的 */
          var title = U.trim(opt.title) || (meta.titleFromHeading ? meta.title : '') ||
            (meta.title ? meta.title : '') || res.title;
          title = U.trim(title).slice(0, 80) || (fileName.replace(/\.(md|markdown|txt)$/i, '') || '未命名試卷');
          res.title = title;
          res.level = (title.match(/(中[一二三四五六]|小[一二三四五六])/) || [])[1] || res.level || '';

          /* 把教師版答案行併回題目（依題號對位；找不到題號就依序補） */
          var nAns = 0;
          answerLines.forEach(function (a, ai) {
            var m = a.match(/^(\d{1,2})[\s.、)）:：]*(.*)$/);
            var q = null;
            if (m) {
              var no = parseInt(m[1], 10);
              q = res.questions.filter(function (x) { return x.no === no; })[0] || null;
              if (q) a = U.trim(m[2]) || a;
            }
            if (!q) {
              /* 沒題號：對到第一個還沒有答案的題目 */
              q = res.questions.filter(function (x) { return !x.answer && !x.answerKeys.length; })[0] || null;
            }
            if (!q || !a) return;
            var am = a.match(/^([A-H])(?:[\s.、)）]|$)/);
            if (am && (q.type === 'mcq' || (q.options && q.options.length))) {
              if (q.answerKeys.indexOf(am[1]) < 0) q.answerKeys.push(am[1]);
              if (!q.answer) q.answer = q.answerKeys.join('、');
            } else if (!q.answer) {
              q.answer = a;
            } else if (q.answer.indexOf(a) < 0) {
              A_APPEND(q, a);
            }
            nAns++;
          });
          function A_APPEND(q, a) { q.answer += '\n' + a; }

          if (nAns) {
            res.warnings = (res.warnings || []).filter(function (w) { return !/教師版/.test(w); });
          } else {
            res.warnings = (res.warnings || []).filter(function (w) { return !/教師版/.test(w); });
          }

          res.mode = 'text';
          res.format = isMd ? 'markdown' : 'text';
          res.markdown = {
            pages: meta.pageCount,
            headings: meta.headings.length,
            tableRows: meta.tableRows,
            answerLines: nAns,
            hasSection: meta.sectionHint
          };

          /* 友善提醒 */
          if (!res.questions.length) {
            res.warnings.push('沒有偵測到任何題目：請確認題號寫在行首（例如「1. …」），或改用「1、」「1 」形式。');
          }
          if (meta.tableRows && !res.questions.some(function (q) { return q.type === 'table'; })) {
            res.warnings.push('有 Markdown 表格但沒有被歸到題目底下：表格請緊接在題目行之後，且中間不要插入空行以外的文字。');
          }
          if (!meta.sectionHint && !meta.headings.length) {
            res.warnings.push('沒有找到「甲部／乙部」或「第一篇／第二篇」標記：文章與題目的分組可能不完整。');
          }
          return res;
        });
    },

    /** 供測試與 UI 使用 */
    looksLikeQuestionOrStem: looksLikeQuestionOrStem,
    rowBlockFromCells: rowBlockFromCells
  };

  RQ.md = Md;
  /* 也掛到 docx 上，方便既有呼叫端辨識來源 */
  if (RQ.docx) RQ.docx.parseText = Md.parseText;
})(window.RQ);
