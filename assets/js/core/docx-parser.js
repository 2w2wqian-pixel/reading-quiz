/* ============================================================
   docx-parser.js — 在瀏覽器端解析 .docx，拆成
   文章 / 題目 / 選項 / 正確答案與解析
   ------------------------------------------------------------
   解析規則（以「啟思／牛津」初中中國語文閱讀卷為參考格式）：

   R1  .docx 本質是 zip，取 word/document.xml 後依「文件順序」還原區塊
       （w:p 段落、w:tbl 表格列）。表格內的段落另行收集，用於文章。
   R2  答案標記：教師版答案文字使用紅色 <w:color w:val="FF0000"/>
       → 紅字即為「正確答案／解析」。顏色可在上傳時覆寫。
   R3  選擇題選項：選項前是 Wingdings 符號 <w:sym w:char="F081"/>…
       F081→A、F082→B、F083→C、F084→D（依序類推）。
   R4  題號：段落以「1～2 位數字」開頭，且該行含（n分）或「？」。
   R5  分數：擷取題幹所有（n分）後加總。
   R6  篇章：在「閱讀能力考材」與「－完－」之間，以「第一篇／第二篇」分段；
       長度 ≥ 25 字的段落視為正文；[n] 開頭者為注釋。
   R7  能力標記：【整合】【引申】【評價】【解釋】 自題幹抽出，另存 skills。
   R8  教師版題目與學生版題目「依題號對位」，把答案與解析併回。
   R9  表格題（填充／判斷）逐一比對學生版與教師版儲存格，
       產生子題（label / prompt / answer）。
   R10 「答案分析：」之後的文字視為解析；若沒有其他答案，解析即為答案。

   任何規則都可能被特殊排版打敗 → 一律提供手動微調介面。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util;
  var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  /* Wingdings 符號 → 選項字母
     Wingdings   F081 → ①  (A)   Wingdings 2  F06A → ①  (A)
     同一字體往後一個碼就是下一個字母 */
  var SYM_BASE = {
    'WINGDINGS': 'F081',
    'WINGDINGS 2': 'F06A',
    'WINGDINGS 3': 'F031'
  };
  var SYM_LETTER = {
    'F081': 'A', 'F082': 'B', 'F083': 'C', 'F084': 'D',
    'F085': 'E', 'F086': 'F', 'F087': 'G', 'F088': 'H'
  };
  function symLetter(font, char) {
    var c = String(char || '').toUpperCase();
    if (/^F0[0-9A-F]{2}$/.test(c) && SYM_LETTER[c]) return SYM_LETTER[c];
    var base = SYM_BASE[String(font || '').toUpperCase()];
    if (base && /^F0[0-9A-F]{2}$/.test(c)) {
      var idx = parseInt(c, 16) - parseInt(base, 16);
      if (idx >= 0 && idx < 26) return String.fromCharCode(65 + idx);
    }
    return null;
  }
  /* 其他常見圓圈符號（Unicode）→ 字母 */
  var UNI_LETTER = {
    '\u2460': 'A', '\u2461': 'B', '\u2462': 'C', '\u2463': 'D', '\u2464': 'E',
    '\u2776': 'A', '\u2777': 'B', '\u2778': 'C', '\u2779': 'D', '\u277A': 'E',
    '\u246A': 'A', '\u246B': 'B', '\u246C': 'C', '\u246D': 'D',
    '\u277F': 'A', '\u2780': 'B', '\u2781': 'C', '\u2782': 'D',
    '\u24B6': 'A', '\u24B7': 'B', '\u24B8': 'C', '\u24B9': 'D', '\u24BA': 'E'
  };

  var RE_QNO   = /^[\s\u3000]*(\d{1,2})[\s\u3000]*([^\d\s])/;
  var RE_MARKS = /[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]/;
  var RE_PASS  = /^[\s\u3000]*第[一二三四五六七八九十]+篇[\s\u3000]*$/;
  var RE_END   = /^[\s\u3000]*[—–－]\s*試\s*卷\s*完\s*[—–－][\s\u3000]*$/;
  var RE_DONE  = /^[\s\u3000]*[—–－]\s*完\s*[—–－][\s\u3000]*$/;
  var RE_ANAL  = /^[\s\u3000]*答\s*案\s*分\s*析\s*[：:]/;
  var RE_REF   = /^[\s\u3000]*(參考答案|學生言之成理|以下為參考)/;

  /* ============================================================
     低階：XML → tokens / blocks
     ============================================================ */
  function localName(n) {
    var s = n.nodeName || '';
    var i = s.indexOf(':');
    return i < 0 ? s : s.slice(i + 1);
  }
  function attr(n, name) { return n.getAttribute(name) || ''; }
  function childByLocal(parent, name) {
    for (var i = 0; i < parent.childNodes.length; i++) {
      var c = parent.childNodes[i];
      if (c.nodeType === 1 && localName(c) === name) return c;
    }
    return null;
  }

  function runIsRed(r, answerColor) {
    var pr = childByLocal(r, 'rPr');
    if (!pr) return false;
    var col = childByLocal(pr, 'color');
    if (!col) return false;
    var v = (attr(col, 'w:val') || attr(col, 'val') || '').toUpperCase();
    if (!v) return false;
    if (v === 'AUTO' || v === '000000') return false;
    return v === String(answerColor || 'FF0000').toUpperCase();
  }

  /** 收集 run 內的 tokens */
  function runTokens(r, tokens, red) {
    for (var i = 0; i < r.childNodes.length; i++) {
      var c = r.childNodes[i];
      if (c.nodeType !== 1) continue;
      var ln = localName(c);
      if (ln === 't') {
        tokens.push({ type: 'text', v: c.textContent || '', red: red });
      } else if (ln === 'tab') {
        tokens.push({ type: 'text', v: ' ', red: red });
      } else if (ln === 'br' || ln === 'cr') {
        tokens.push({ type: 'text', v: '\n', red: red });
      } else if (ln === 'sym') {
        var ch = (attr(c, 'w:char') || attr(c, 'char') || '').toUpperCase();
        var font = (attr(c, 'w:font') || attr(c, 'font') || '');
        var letter = symLetter(font, ch) || (UNI_LETTER[c.textContent || ''] || null);
        tokens.push({ type: 'sym', v: ch, font: font, letter: letter, red: red });
      } else if (ln === 'delText' || ln === 'drawing' || ln === 'pict' || ln === 'object') {
        /* 忽略 */
      } else if (ln === 'instrText') {
        /* 忽略 */
      } else {
        collectTokens(c, tokens, red);
      }
    }
  }

  /** 遞迴收集（保留文件順序） */
  function collectTokens(node, tokens, red) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType !== 1) continue;
      var ln = localName(c);
      if (ln === 'r') {
        runTokens(c, tokens, red || runIsRed(c, collectTokens._color));
      } else if (ln === 'pPr' || ln === 'rPr' || ln === 'tblPr' || ln === 'trPr' || ln === 'tcPr') {
        /* 屬性，略過 */
      } else if (ln === 'txbxContent' || ln === 'hyperlink' || ln === 'smartTag' ||
                 ln === 'ins' || ln === 'del' || ln === 'sdt' || ln === 'sdtContent' ||
                 ln === 'dir' || ln === 'bdo' || ln === 'AlternateContent' ||
                 ln === 'Choice' || ln === 'Fallback' || ln === 'bookmarkStart') {
        collectTokens(c, tokens, red);
      } else if (ln === 'p' || ln === 'tbl' || ln === 'tr' || ln === 'tc') {
        collectTokens(c, tokens, red);
      } else {
        collectTokens(c, tokens, red);
      }
    }
  }

  /** tokens → 純文字（符號轉成 (A) 形式） */
  function tokensText(tokens) {
    var s = '';
    tokens.forEach(function (t) {
      if (t.type === 'text') s += t.v;
      else if (t.type === 'sym' && t.letter) s += '(' + t.letter + ')';
    });
    return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  }
  /** 只看得見的文字（不含符號） */
  function tokensVisible(tokens) {
    var s = '';
    tokens.forEach(function (t) { if (t.type === 'text') s += t.v; });
    return U.trim(s);
  }
  function tokensSymCount(tokens) {
    var n = 0;
    tokens.forEach(function (t) { if (t.type === 'sym') n++; });
    return n;
  }
  function tokensRed(tokens) {
    return tokens.some(function (t) { return t.red && (t.type === 'text' ? /\S/.test(t.v) : true); });
  }
  function tokensLetters(tokens) {
    var out = [];
    tokens.forEach(function (t) {
      if (t.type === 'sym' && t.letter) out.push(t.letter);
      else if (t.type === 'text') {
        var m = t.v.match(/[\u2460-\u2468\u2776-\u277E\u24B6-\u24CF]/g);
        if (m) m.forEach(function (ch) { if (UNI_LETTER[ch]) out.push(UNI_LETTER[ch]); });
      }
    });
    return out;
  }

  /** 從 tokens 抽出選擇題選項 */
  function extractOptions(tokens) {
    var opts = [], cur = null;
    tokens.forEach(function (t) {
      if (t.type === 'sym' && t.letter) {
        if (cur) opts.push(cur);
        cur = { key: t.letter, text: '', red: false };
      } else if (t.type === 'text') {
        if (cur) { cur.text += t.v; if (t.red && /\S/.test(t.v)) cur.red = true; }
      } else if (t.type === 'sym' && cur && t.red) {
        cur.red = true;
      }
    });
    if (cur) opts.push(cur);
    return opts
      .map(function (o) {
        return {
          key: o.key,
          text: U.trim(o.text.replace(/[\n\t]+/g, ' ').replace(/\s{2,}/g, ' ')),
          red: !!o.red
        };
      })
      .filter(function (o) { return o.text.length > 0; });
  }

  /** 段落（w:p）→ block */
  function paraBlock(p, color) {
    var tokens = [];
    collectTokens._color = color;
    collectTokens(p, tokens, false);
    var text = U.trim(tokensText(tokens));
    return {
      kind: 'p', node: p, tokens: tokens, text: text,
      red: tokensRed(tokens),
      letters: tokensLetters(tokens),
      options: extractOptions(tokens)
    };
  }

  /** 表格列（w:tr）→ block */
  function rowBlock(tr, color) {
    var cells = [], red = false, letters = [], options = [];
    var tcs = [];
    for (var i = 0; i < tr.childNodes.length; i++) {
      var c = tr.childNodes[i];
      if (c.nodeType === 1 && localName(c) === 'tc') tcs.push(c);
    }
    tcs.forEach(function (tc) {
      var ps = [];
      for (var j = 0; j < tc.childNodes.length; j++) {
        var cc = tc.childNodes[j];
        if (cc.nodeType === 1 && localName(cc) === 'p') ps.push(cc);
      }
      var toks = [];
      collectTokens._color = color;
      if (ps.length) ps.forEach(function (p) { collectTokens(p, toks, false); });
      else collectTokens(tc, toks, false);
      var txt = U.trim(tokensText(toks));
      var vis = tokensVisible(toks);
      var symN = tokensSymCount(toks);
      if (tokensRed(toks)) red = true;
      letters = letters.concat(tokensLetters(toks));
      options = options.concat(extractOptions(toks));
      cells.push({
        text: txt,
        visible: vis,
        red: tokensRed(toks),
        sym: symN,
        /* 只有符號、沒有文字，且是紅色 → 教師版的勾選記號 */
        tick: tokensRed(toks) && vis === '' && symN > 0,
        letters: tokensLetters(toks)
      });
    });
    return {
      kind: 'tr', node: tr, cells: cells,
      text: cells.map(function (c) { return c.text; }).join(' | '),
      red: red, letters: letters, options: options
    };
  }

  /* ============================================================
     主解析流程
     ============================================================ */
  function buildBlocks(bodyEl, color) {
    var top = [], paras = [];
    for (var i = 0; i < bodyEl.childNodes.length; i++) {
      var c = bodyEl.childNodes[i];
      if (c.nodeType !== 1) continue;
      var ln = localName(c);
      if (ln === 'p') top.push(paraBlock(c, color));
      else if (ln === 'tbl') {
        for (var j = 0; j < c.childNodes.length; j++) {
          var r = c.childNodes[j];
          if (r.nodeType === 1 && localName(r) === 'tr') top.push(rowBlock(r, color));
        }
      } else if (ln === 'sdt' || ln === 'sdtContent') {
        /* 內容控制項：展開 */
        var inner = c.getElementsByTagName('w:p');
        for (var k = 0; k < inner.length; k++) top.push(paraBlock(inner[k], color));
      }
    }
    var allP = bodyEl.getElementsByTagName('w:p');
    for (var m = 0; m < allP.length; m++) paras.push(paraBlock(allP[m], color));
    return { top: top, paras: paras };
  }

  function findIndex(arr, pred, from) {
    for (var i = (from || 0); i < arr.length; i++) if (pred(arr[i], i)) return i;
    return -1;
  }
  function findLastIndex(arr, pred) {
    for (var i = arr.length - 1; i >= 0; i--) if (pred(arr[i], i)) return i;
    return -1;
  }

  function isQStart(b) {
    if (b.kind !== 'p') return false;
    var t = b.text;
    var m = t.match(RE_QNO);
    if (!m) return false;
    if (t.length < 6) return false;
    if (!U.cjk.test(m[2])) return false;
    if (!(RE_MARKS.test(t) || t.indexOf('？') >= 0 || t.indexOf('?') >= 0)) return false;
    return true;
  }
  function qno(b) { var m = b.text.match(RE_QNO); return m ? parseInt(m[1], 10) : null; }

  /** 選擇題作答格：如「A只有、」＋「A|B|C|D」 */
  function isGridRow(b) {
    if (b.kind !== 'tr') return false;
    var cells = b.cells.map(function (c) { return U.trim(c.visible || c.text); })
      .filter(function (x) { return x; });
    if (cells.length < 2) return false;
    var allShort = cells.every(function (x) { return x.length <= 16 && /^[A-Ha-h]/.test(x); });
    if (allShort) return true;
    /* 「A 只有(A)、(B)」這種組合式選擇題：首格含「只有」，其餘是單一字母 */
    if (/只有|及|與/.test(cells[0]) && cells.length >= 3) {
      return cells.slice(1).every(function (x) { return /^[A-Da-d]$/.test(x); });
    }
    return false;
  }

  /* ---------- 文章 ---------- */
  function extractPassages(paras, startNode, endNode) {
    // 用 node 位置篩選（paras 為整份文件的段落，依文件順序）
    var idx0 = -1, idx1 = -1;
    for (var i = 0; i < paras.length; i++) {
      if (paras[i].node === startNode) { idx0 = i; break; }
    }
    if (idx0 < 0) return [];
    for (var j = idx0 + 1; j < paras.length; j++) {
      if (paras[j].node === endNode) { idx1 = j; break; }
    }
    if (idx1 < 0) idx1 = paras.length;

    var out = [], cur = null, inNotes = false, notes = [];
    for (var k = idx0 + 1; k < idx1; k++) {
      var t = U.trim(paras[k].text);
      if (!t) continue;
      if (/^[\s\u3000]*考\s*生\s*須\s*知/.test(t)) continue;
      if (/^[（(][一二三四五六七八九十][）)]/.test(t) && /閱讀能力考材|依據|刪改/.test(t)) continue;
      if (/版權所有|啟思出版社|牛津大學出版社|初中中國語文|閱讀能力考材|試\s*題\s*答\s*題\s*簿/.test(t)) continue;
      if (RE_PASS.test(t)) {
        if (cur) { cur.notes = notes; out.push(cur); notes = []; }
        cur = { id: 'p' + (out.length + 1), title: U.trim(t), paragraphs: [], notes: [] };
        inNotes = false;
        continue;
      }
      if (/^[\s\u3000]*注\s*釋[\s\u3000]*$/.test(t)) { inNotes = true; continue; }
      if (!cur) continue;
      if (t.length >= 25) { cur.paragraphs.push(t); continue; }
      if (inNotes && /^\[\d+\]/.test(t)) { notes.push(t); continue; }
      if (/^[\(（]?\d+[\)）]?[\s\u3000]*$/.test(t)) continue;   // (1) (2) 段號
      if (/^[\s\u3000]*段\s*落[\s\u3000]*$/.test(t)) continue;
      if (/^《.+》[\s\u3000]*$/.test(t)) { cur.source = t; continue; }
      if (/^《.+》/.test(t) && t.length < 40) { cur.source = t; continue; }
      if (/^[\s\u3000]*語\s*譯[\s\u3000]*$/.test(t)) { inNotes = false; continue; }
      if (/^\[\d+\]/.test(t)) { notes.push(t); continue; }
      if (/^《.+》\(/.test(t)) { cur.source = t; continue; }
    }
    if (cur) { cur.notes = notes; out.push(cur); notes = []; }
    return out.filter(function (p) { return p.paragraphs.length; });
  }

  /* ---------- 題目（學生版 / 教師版共用收集器） ---------- */
  function collectQuestions(blocks, from, to, isTeacher) {
    var qs = [], i = from, curPassage = 0;
    while (i < to) {
      var b = blocks[i];
      if (b.kind === 'p' && b.text.length <= 20 && RE_PASS.test(b.text)) { curPassage++; i++; continue; }
      if (!isQStart(b)) { i++; continue; }

      var no = qno(b);
      var stemRaw = b.text.replace(/^[\s\u3000]*\d{1,2}[\s\u3000]*/, '');
      var sk = U.stripSkills(stemRaw);
      var q = {
        no: no,
        stem: sk.text,
        skills: sk.skills,
        marks: U.sumMarks(b.text) || 0,
        passageIndex: curPassage,
        type: 'text',
        options: [],
        subQuestions: [],
        table: null,
        answer: '',
        answerKeys: [],
        explanation: '',
        raw: []
      };

      var j = i + 1, inAnalysis = false;
      while (j < to) {
        var nb = blocks[j];
        if (isQStart(nb) || (nb.kind === 'p' && nb.text.length <= 20 && RE_PASS.test(nb.text))) break;

        if (nb.kind === 'tr') {
          if (isGridRow(nb)) {
            /* 記錄被勾選的欄位（紅色）→ 可能就是答案的組合行 */
            nb.cells.forEach(function (c, ci) {
              if (c.red && ci > 0) q.gridMarks = (q.gridMarks || []).concat([String.fromCharCode(64 + ci)]);
            });
            j++; continue;                                    // A B C D 作答格
          }
          q.table = q.table || { rows: [] };
          q.table.rows.push(nb.cells.map(function (c) {
            return { text: U.trim(c.text), visible: c.visible, red: c.red, tick: c.tick, sym: c.sym };
          }));
          q.raw.push('[表] ' + nb.text);
        } else {
          var txt = U.trim(nb.text);
          if (!txt) { j++; continue; }
          if (RE_ANAL.test(txt)) {
            inAnalysis = true;
            q.explanation += (q.explanation ? '\n' : '') + txt.replace(RE_ANAL, '');
            j++; continue;
          }
          if (nb.options.length) {
            nb.options.forEach(function (o) { q.options.push(o); });
            j++; continue;                       // 選項文字不當答案
          }
          if (inAnalysis) {
            q.explanation += (q.explanation ? '\n' : '') + txt;
          } else {
            q.raw.push(txt);
          }
        }
        j++;
      }

      /* 教師版：紅字即答案 */
      if (isTeacher) {
        var reds = [];
        for (var r = i + 1; r < j; r++) {
          var rb = blocks[r];
          if (rb.kind === 'p' && RE_ANAL.test(rb.text)) continue;
          if (rb.kind === 'tr') {
            if (isGridRow(rb)) continue;      // A B C D 作答格不算答案
            rb.cells.forEach(function (c) {
              if (c.red && U.trim(c.text) && !c.tick) reds.push(U.trim(c.text));
            });
            continue;
          }
          if (rb.options && rb.options.length) {
            /* 選項段落：教師版把正確選項標紅 → 直接得到答案字母 */
            rb.options.forEach(function (o) {
              if (o.red) q._redOptionKeys = (q._redOptionKeys || []).concat([o.key]);
            });
            continue;
          }
          if (rb.red) reds.push(U.trim(rb.text));
        }
        q._redAnswers = reds;
        q._plainBody = q.raw.slice();
      }

      qs.push(q);
      i = j;
    }
    return qs;
  }

  /* ---------- 合併學生版 + 教師版 ---------- */
  function mergeVersions(studentQs, teacherQs) {
    var tmap = {};
    teacherQs.forEach(function (q) { if (!tmap[q.no]) tmap[q.no] = q; });

    studentQs.forEach(function (q) {
      var t = tmap[q.no];
      if (q.options.length >= 2) q.type = 'mcq';
      else if (q.table) q.type = 'table';
      else q.type = 'text';

      if (!t) { q._warn = '教師版找不到第 ' + q.no + ' 題'; return; }

      /* 答案文字：優先紅字，其次教師版題目後的所有文字 */
      var ansList = (t._redAnswers && t._redAnswers.length) ? t._redAnswers.slice() : [];
      if (!ansList.length) {
        ansList = (t._plainBody || []).filter(function (x) {
          return !RE_REF.test(x) && !RE_ANAL.test(x);
        });
      }
      /* 去掉「學生言之成理即可／以下為參考答案」這類引導語 */
      ansList = ansList.filter(function (x) {
        return !/^(學生言之成理|以下為參考答案|言之成理即可)/.test(U.trim(x)) && U.trim(x);
      });

      q.explanation = U.trim(t.explanation || '');
      /* 答案不要把解析重複放進來 */
      if (q.explanation) {
        var exLines = q.explanation.split('\n').map(U.trim);
        ansList = ansList.filter(function (x) { return exLines.indexOf(U.trim(x)) < 0; });
      }
      q.answer = U.trim(ansList.join('\n'));

      if (q.type === 'mcq') {
        var keys = parseAnswerKeys((q.explanation || '') + ' ' + (q.answer || ''));
        /* 教師版把正確選項標紅也是很常見的做法 */
        if (!keys.length && t._redOptionKeys && t._redOptionKeys.length) keys = t._redOptionKeys.slice();
        keys = keys.filter(function (k, i, a) { return a.indexOf(k) === i; }).sort();
        q.answerKeys = keys;
        q.multi = keys.length > 1;
        if (!keys.length) q._warn = '第 ' + q.no + ' 題未能判讀正確選項，請手動勾選';
        /* 選項題的答案文字就用正確選項內容 */
        q.answer = keys.length
          ? keys.map(function (k) {
              var o = q.options.filter(function (x) { return x.key === k; })[0];
              return k + '. ' + (o ? o.text : '');
            }).join('；')
          : U.trim((q.explanation || '').split('\n')[0]);
      }

      if (q.type === 'table') buildSubQuestions(q, t);
      delete q.gridMarks;
    });

    /* 教師版有、學生版沒有的題目也補進來 */
    var smap = {};
    studentQs.forEach(function (q) { smap[q.no] = 1; });
    teacherQs.forEach(function (t) {
      if (smap[t.no]) return;
      var q = {
        no: t.no, stem: t.stem, skills: t.skills, marks: t.marks,
        passageIndex: t.passageIndex,
        type: (t.options.length >= 2 ? 'mcq' : (t.table ? 'table' : 'text')),
        options: t.options, subQuestions: [], table: t.table,
        answer: U.trim((t._redAnswers || []).join('\n') || (t._plainBody || []).join('\n')),
        answerKeys: [], explanation: U.trim(t.explanation || ''),
        _warn: '僅見於教師版', raw: t.raw
      };
      if (q.type === 'mcq') q.answerKeys = parseAnswerKeys(q.answer + ' ' + q.explanation, t);
      if (q.type === 'table') buildSubQuestions(q, t);
      studentQs.push(q);
    });

    studentQs.sort(function (a, b) { return a.no - b.no; });
    return studentQs;
  }

  /**
   * 從解析／答案文字判讀正確選項。
   * 例：「故選項(A)、(C)正確……故選項(D)不正確」→ ['A','C']
   */
  function parseAnswerKeys(src) {
    var s = String(src || '');
    var keys = [], bad = [];
    var re = /選\s*項\s*((?:[\(（]?[A-Ha-h][）)]?\s*[、,和與及]?\s*){1,8}?)\s*(不\s*正\s*確|錯\s*誤|正\s*確)/g;
    var m;
    while ((m = re.exec(s))) {
      var ls = (m[1].match(/[A-Ha-h]/g) || []).map(function (c) { return c.toUpperCase(); });
      if (/不\s*正\s*確|錯\s*誤/.test(m[2])) bad = bad.concat(ls);
      else keys = keys.concat(ls);
    }
    if (!keys.length) {
      m = /答\s*案\s*(?:為|是)?[\s:：]*[\(（]?([A-Ha-h])/.exec(s);
      if (m) keys = [m[1].toUpperCase()];
    }
    return keys
      .filter(function (k) { return bad.indexOf(k) < 0; })
      .filter(function (k, i, a) { return a.indexOf(k) === i; })
      .sort();
  }

  function subLabel(rowLabel, seq) {
    var a = [rowLabel, seq].filter(function (x) { return U.trim(x || ''); });
    return a.join(' / ').replace(/\s+/g, ' ');
  }

  function buildSubQuestions(q, t) {
    var sRows = (q.table && q.table.rows) || [];
    var tRows = (t.table && t.table.rows) || [];
    var subs = [];
    /* 標題列：教師版第一列（通常是欄位名稱，如「肖像描寫／正確／錯誤」） */
    var tHead = tRows[0] || sRows[0] || [];
    var header = tHead.map(function (c) { return U.trim(c.text || ''); });

    var n = Math.max(sRows.length, tRows.length);
    for (var r = 0; r < n; r++) {
      var sr = sRows[r] || [], tr = tRows[r] || [];
      var rowLabel = U.trim((sr[0] && sr[0].text) || (tr[0] && tr[0].text) || '');
      var seq = (String(rowLabel).match(/^[\(（]\d+[\)）]/) || [])[0] || '';
      var cn = Math.max(sr.length, tr.length);
      var tickSeen = false;

      for (var c = 0; c < cn; c++) {
        var sc = sr[c], tc = tr[c];
        var sVis = sc ? U.trim(sc.visible || sc.text) : '';
        var tVis = tc ? U.trim(tc.visible || tc.text) : '';
        var tTxt = tc ? U.trim(tc.text) : '';
        var sTxt = sc ? U.trim(sc.text) : '';

        /* ① 勾選題：教師版該格有勾（紅色記號）→ 答案是欄位標題 */
        if (tc && tc.tick) {
          tickSeen = true;
          subs.push({
            id: 'q' + q.no + '_' + r + '_' + c,
            label: subLabel(rowLabel, seq) || ('第 ' + (r + 1) + ' 列'),
            prompt: sVis || rowLabel,
            answer: header[c] || tVis || '✔',
            marks: U.sumMarks(tTxt),
            kind: 'tick'
          });
          continue;
        }
        if (!sTxt && !tTxt) continue;
        if (sTxt === tTxt) continue;          // 內容相同 → 只是標籤
        if (r === 0 && !tTxt) continue;       // 標題列

        var seqT = (tTxt.match(/^[\(（]\d+[\)）]/) || sTxt.match(/^[\(（]\d+[\)）]/) || [''])[0];
        subs.push({
          id: 'q' + q.no + '_' + r + '_' + c,
          label: subLabel(c > 0 ? rowLabel : '', seqT || seq) || ((r + 1) + '-' + (c + 1)),
          prompt: sTxt,
          answer: tTxt,
          marks: U.sumMarks(tTxt),
          kind: 'fill'
        });
      }
      if (tickSeen) continue;
    }

    q.subQuestions = subs;
    if (subs.length && !q.marks) {
      q.marks = subs.reduce(function (a, s) { return a + (s.marks || 0); }, 0);
    }
    /* 表格題的答案改由子題組成，顯示較清爽 */
    if (subs.length && subs.every(function (s) { return s.answer; })) {
      q.answer = subs.map(function (s) {
        return (s.label ? s.label + '　' : '') + s.answer;
      }).join('\n');
    }
  }

  /* ============================================================
     對外 API
     ============================================================ */
  var Docx = {
    /**
     * @param {ArrayBuffer|File} input
     * @param {Object} opt {answerColor:'FF0000', fileName:'xxx.docx'}
     * @returns {Promise} {title, passages, questions, warnings, stats}
     */
    parse: function (input, opt) {
      opt = opt || {};
      var color = opt.answerColor || 'FF0000';
      var fileName = opt.fileName || '';

      return Promise.resolve()
        .then(function () {
          if (typeof File !== 'undefined' && input instanceof File) {
            return U.readFileAsArrayBuffer(input);
          }
          return input;
        })
        .then(function (buf) {
          if (typeof JSZip === 'undefined') throw new Error('缺少 JSZip 函式庫，無法解壓 .docx');
          return JSZip.loadAsync(buf);
        })
        .then(function (zip) {
          var f = zip.file('word/document.xml');
          if (!f) throw new Error('這不是有效的 .docx（找不到 word/document.xml）');
          return f.async('string');
        })
        .then(function (xml) { return Docx.parseXML(xml, color, fileName); });
    },

    parseXML: function (xml, color, fileName) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var perr = doc.getElementsByTagName('parsererror');
      if (perr && perr.length) throw new Error('XML 解析失敗');

      var bodyEl = doc.getElementsByTagName('w:body')[0] ||
                   doc.getElementsByTagName('body')[0];
      if (!bodyEl) throw new Error('找不到文件主體');

      var built = buildBlocks(bodyEl, color);
      var top = built.top, paras = built.paras;
      var warnings = [];

      /* ---- 標題 ---- */
      var title = '';
      for (var i = 0; i < Math.min(top.length, 12); i++) {
        var t = U.trim(top[i].text);
        if (t && !/^©|版權所有/.test(t)) { title = t; break; }
      }
      var tm = title.match(/(?:中|小)[一二三四五六][^\s，。]{0,14}(?:試卷|考卷|測驗|評估)[^\s，。]{0,10}/);
      if (tm) title = tm[0];
      title = U.trim(title).slice(0, 40) || (fileName ? fileName.replace(/\.docx?$/i, '') : '未命名試卷');

      /* ---- 區段定位 ---- */
      var isShort = function (b) { return b.kind === 'p' && b.text.length <= 20; };
      var teacherIdx = findIndex(top, function (b) { return /教\s*師\s*版/.test(b.text); });
      var matIdx = findIndex(top, function (b) {
        return isShort(b) && /閱\s*讀\s*能\s*力\s*考\s*材/.test(b.text);
      });
      if (matIdx < 0) {
        warnings.push('找不到「閱讀能力考材」標題，文章可能闕漏，請檢查。');
      }

      /* ---- 文章 ---- */
      var passages = [];
      if (matIdx >= 0) {
        var doneIdx = findIndex(top, function (b, k) { return k > matIdx && isShort(b) && RE_DONE.test(b.text); });
        if (doneIdx < 0) {
          doneIdx = findIndex(top, function (b, k) { return k > matIdx && isShort(b) && /語\s*譯/.test(b.text); });
        }
        var endNode = doneIdx > 0 ? top[doneIdx].node : null;
        passages = extractPassages(paras, top[matIdx].node, endNode);
      }
      if (!passages.length) {
        warnings.push('未能擷取文章，請在上傳後手動貼上或修正。');
      }

      /* ---- 學生版題目 ---- */
      var sFrom = findIndex(top, function (b) { return isShort(b) && RE_PASS.test(b.text); });
      if (sFrom < 0) sFrom = 0;
      var sEnd = findIndex(top, function (b, k) { return k >= sFrom && isShort(b) && RE_END.test(b.text); });
      if (sEnd < 0) sEnd = (matIdx > 0 ? matIdx : (teacherIdx > 0 ? teacherIdx : top.length));
      var studentQs = collectQuestions(top, sFrom, sEnd, false);

      /* ---- 教師版題目 ---- */
      var teacherQs = [];
      if (teacherIdx >= 0) {
        var tFrom = findIndex(top, function (b, k) { return k >= teacherIdx && isShort(b) && RE_PASS.test(b.text); });
        if (tFrom < 0) tFrom = teacherIdx;
        var tEnd = findIndex(top, function (b, k) { return k > tFrom && isShort(b) && RE_END.test(b.text); });
        if (tEnd < 0) tEnd = top.length;
        teacherQs = collectQuestions(top, tFrom, tEnd, true);
      } else {
        warnings.push('找不到「教師版」區段：本卷可能只有學生版，答案需自行填寫或另外上傳教師卷。');
      }

      /* ---- 合併 ---- */
      var questions = mergeVersions(studentQs, teacherQs);

      /* ---- 篇章指派 ---- */
      questions.forEach(function (q) {
        var pi = Math.min(Math.max(q.passageIndex, 1), passages.length || 1) - 1;
        q.passageId = passages[pi] ? passages[pi].id : null;
      });

      /* ---- 後處理 ---- */
      questions.forEach(function (q) {
        q.id = 'q' + q.no;
        if (q.type === 'table' && (!q.subQuestions || !q.subQuestions.length) && !q.answer) {
          q._warn = '第 ' + q.no + ' 題為表格題但抓不到答案，請手動補充';
        }
        if (q.type !== 'mcq' && !q.answer && q.explanation) {
          q.answer = q.explanation;
          q.explanation = '';
        }
        if (q._warn) warnings.push(q._warn);
        delete q._warn;
        delete q._redAnswers;
        delete q._plainBody;
        delete q.raw;
      });

      var totalMarks = questions.reduce(function (a, q) { return a + (q.marks || 0); }, 0);

      var level = '';
      var lm = title.match(/(中[一二三四五六]|小[一二三四五六])/);
      if (lm) level = lm[1];

      return {
        title: title,
        level: level,
        source: fileName || '',
        passages: passages,
        questions: questions,
        totalMarks: totalMarks,
        warnings: warnings,
        stats: {
          blocks: top.length,
          paras: paras.length,
          questions: questions.length,
          passages: passages.length,
          hasTeacher: teacherIdx >= 0,
          mcq: questions.filter(function (q) { return q.type === 'mcq'; }).length,
          table: questions.filter(function (q) { return q.type === 'table'; }).length
        }
      };
    },

    /**
     * 兩份檔案：學生卷 + 教師卷
     */
    parsePair: function (studentInput, teacherInput, opt) {
      opt = opt || {};
      return Promise.all([
        Docx.parse(studentInput, Object.assign({}, opt, { fileName: opt.studentName })),
        Docx.parse(teacherInput, Object.assign({}, opt, { fileName: opt.teacherName }))
      ]).then(function (r) {
        var s = r[0], t = r[1];
        /* 教師卷的題目重新當教師版用 */
        var questions = mergeVersions(s.questions, t.questions.map(function (q) {
          q._redAnswers = [q.answer].concat(q.subQuestions.map(function (x) { return x.answer; })).filter(Boolean);
          q._plainBody = [q.answer];
          return q;
        }));
        questions.forEach(function (q) {
          var pi = Math.min(Math.max(q.passageIndex, 1), s.passages.length || 1) - 1;
          q.passageId = s.passages[pi] ? s.passages[pi].id : null;
          q.id = 'q' + q.no;
          delete q._redAnswers; delete q._plainBody; delete q.raw; delete q._warn;
        });
        s.questions = questions;
        s.totalMarks = questions.reduce(function (a, q) { return a + (q.marks || 0); }, 0);
        s.warnings = s.warnings.concat(t.warnings).concat(['已合併學生卷與教師卷']);
        return s;
      });
    },

    /* 供偵錯 */
    _internal: { SYM_LETTER: SYM_LETTER, buildBlocks: buildBlocks, isQStart: isQStart }
  };

  RQ.docx = Docx;
})(window.RQ);
