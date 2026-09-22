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

  /* 題號起手：數字 + 可選的中間符號（. 、 ) ．） + 一個「內容起頭字元」。
     中間符號是 Markdown／文字版匯入的關鍵：docx 是「1 題目」（數字後接空白），
     但文字版幾乎一定寫成「1. 題目」「1、題目」；沒有把符號吃掉的話，
     內容起頭字元會變成「.」而過不了 RE_QFIRST，整題消失（實測踩雷）。
     `(1)` 這種括號題號則交由 RE_QPAREN 另管，維持原行為。 */
  var RE_QNO   = /^[\s\u3000]*(\d{1,2})[\s\u3000]*[.、．。)）]?[\s\u3000]*([^\d\s.、．。)）])/;
  var RE_QNO_STRIP = /^[\s\u3000]*\d{1,2}[\s\u3000]*[.、．。)）]?[\s\u3000]*/;
  var RE_MARKS = /[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]/;
  var RE_PASS  = /^[\s\u3000]*第[一二三四五六七八九十]+篇[\s\u3000]*$/;
  var RE_END   = /^[\s\u3000]*[—–－]\s*試\s*卷\s*完\s*[—–－][\s\u3000]*$/;
  var RE_DONE  = /^[\s\u3000]*[—–－]\s*完\s*[—–－][\s\u3000]*$/;
  var RE_ANAL  = /^[\s\u3000]*答\s*案\s*分\s*析\s*[：:]/;
  var RE_REF   = /^[\s\u3000]*(參考答案|學生言之成理|以下為參考)/;
  /* 甲部／乙部 等分卷標記（注意：文中多為全形空格 U+3000；CJK 後無 \b 詞界） */
  var RE_SECTION = /^[\s\u3000]*[甲乙丙丁戊己庚辛壬癸][\s\u3000]*部/;
  /* 純文字／Markdown 來源的答案行：md-parser 前處理時會轉成「★ 3. B」。
     ★ 不在 RE_QNO 的「數字開頭」規則內，所以既不會被當成題號、
     也不會被當成題幹被吞掉，只會靜靜地留在原地等 isTeacher 來取。 */
  var RE_MDANS = /^[\s\u3000]*[★☆✔✓√☑]/;
  /* 引文（給學生看的參考文字，不是答案）的強信號 */
  function isQuoteLike(b) {
    if (b.kind !== 'p') return false;
    var t = U.trim(b.text);
    if (!t) return false;
    if (b.options && b.options.length) return false;
    if (t.indexOf('？') >= 0 || t.indexOf('?') >= 0) return false;
    if (/^引文|^以下引文|（第.+段）/.test(t)) return true;
    /* 含開引號（「『“(（《）且夠長，才是引文；避免誤抓以 。結尾的題幹 */
    if (t.length >= 10 && /[「『“(（《]/.test(t)) return true;
    return false;
  }
  /* 給學生看的參考文字：要解釋的句子／字詞、選項說明、引文…
     （只要不是表格／選項／解析，就不要默默丟掉，一律當成參考文字顯示） */
  function isRefText(t) {
    if (!t) return false;
    if (/^[＿_\s\u3000.．·・…\-–—－※│|]+$/.test(t)) return false;   // 只有底線／標點／空白
    if (/^\d{1,3}$/.test(t)) return false;                           // 純頁碼
    return U.trim(t).length >= 2;
  }
  /* 同一行內的多個選項標記（PDF 常見）："A. x　B. y" */
  var RE_OPT_MARK = /([A-H])\s*[.、)．:：]\s+/g;   /* 左邊界不要求空白：PDF／docx 常出現「…mistakesC. …」 */

  /**
   * 把「同一行排了多個選項」的行切成多段（PDF 常見：「A. 只有　B. 沒有　C. 都有」）。
   * docx 是一段一個選項，解析器只認獨立成段的選項，所以 PDF 需要先切開，
   * 才能吃到與 docx 完全相同的選項收集邏輯。
   * 只有「A、B、C…連續且從 A 開始」才切，避免把 E.、I. 之類的縮寫誤判成選項。
   */
  function splitOptionLine(line) {
    var t = String(line == null ? '' : line);
    var marks = [], m;
    RE_OPT_MARK.lastIndex = 0;
    while ((m = RE_OPT_MARK.exec(t))) {
      var lead = /^[\s\u3000]/.test(m[0]) ? 1 : 0;
      marks.push({ at: m.index + lead, letter: m[1] });
      RE_OPT_MARK.lastIndex = m.index + lead + 1;
    }
    if (marks.length < 2) return [t];
    for (var i = 0; i < marks.length; i++) {
      if (marks[i].letter !== String.fromCharCode(65 + i)) return [t];
    }
    var out = [];
    if (marks[0].at > 0) out.push(t.slice(0, marks[0].at));
    for (var k = 0; k < marks.length; k++) {
      var end = (k + 1 < marks.length) ? marks[k + 1].at : t.length;
      out.push(t.slice(marks[k].at, end));
    }
    return out;
  }

  /* 英文選項段落：A. / B) / C、 … */
  function isEnglishOption(b) {
    if (b.kind !== 'p') return false;
    var t = U.trim(b.text);
    if (!t) return false;
    return /^[A-H][.、)]\s+/.test(t);
  }
  /* 真／假／無從判斷、True/False/Not Given 表格 */
  function isTFNG(headerCells) {
    var joined = (headerCells || []).join(' ');
    return /正確|錯誤|無從判斷/i.test(joined) || /true|false|not given/i.test(joined);
  }
  /* 段落劃分／概括題（如「本文共有7個段落，分成四個部分，試指出各部分由哪些段落組成」）
     → 不適合線上作答，解析後標記略過 */
  function isSectionSplitQ(q) {
    var s = String(q.stem || '');
    if (/個段落/.test(s) && (/分成/.test(s) || /哪些段落組成/.test(s) || /各部分/.test(s))) return true;
    var rows = (q.table && q.table.rows) || [];
    if (!rows.length) return false;
    var head = rows[0].map(function (c) { return U.trim((c && (c.text || c.visible)) || ''); }).join('');
    var hasPara = rows.some(function (r) {
      return (r || []).some(function (c) {
        var t = U.trim((c && (c.text || c.visible)) || '');
        return /第[\s\u3000]{1,4}段/.test(t) || /^第\s*段$/.test(t);
      });
    });
    return /部分/.test(head) && /段落/.test(head) && hasPara;
  }

  /* 英文閱讀文章：介於 "Reading Text" 與 "END OF READING TEXT" 之間的
     段落與表格（表格取其最長、非頁碼那一格） */
  function extractEnglishArticle(blocks, from, to) {
    var paras = [];
    for (var k = from + 1; k < to; k++) {
      var b = blocks[k];
      if (b.kind === 'p') {
        var t = U.trim(b.text);
        if (t && !/^END OF/i.test(t)) paras.push(t);
      } else if (b.kind === 'tr') {
        var best = '', bestLen = 0;
        (b.cells || []).forEach(function (c) {
          var v = U.trim(c.text || '');
          if (/^\d{1,4}$/.test(v)) return;            // 略過頁碼邊欄
          if (v.length > bestLen) { bestLen = v.length; best = v; }
        });
        if (best) paras.push(best);
      }
    }
    paras = paras.filter(function (p) { return p.length > 1; });
    return paras.length
      ? [{ id: 'p1', title: 'Reading Text', paragraphs: paras, notes: [] }]
      : [];
  }

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

  /* 讀取 run 的格式：紅字（答案）／粗體／底線（保留原卷樣式用） */
  function runFmt(r, answerColor) {
    var f = { red: false, bold: false, underline: false };
    var pr = childByLocal(r, 'rPr');
    if (pr) {
      var col = childByLocal(pr, 'color');
      if (col) {
        var v = (attr(col, 'w:val') || attr(col, 'val') || '').toUpperCase();
        if (v && v !== 'AUTO' && v !== '000000' && v === String(answerColor || 'FF0000').toUpperCase()) f.red = true;
      }
      var b = childByLocal(pr, 'b');
      if (b) {
        var bv = (attr(b, 'w:val') || attr(b, 'val') || '').toLowerCase();
        if (bv !== '0' && bv !== 'false') f.bold = true;
      }
      var u = childByLocal(pr, 'u');
      if (u) {
        var uv = (attr(u, 'w:val') || attr(u, 'val') || 'single');
        if (uv !== 'none') f.underline = true;
      }
    }
    return f;
  }

  /** 收集 run 內的 tokens */
  function runTokens(r, tokens, fmt) {
    fmt = fmt || {};
    for (var i = 0; i < r.childNodes.length; i++) {
      var c = r.childNodes[i];
      if (c.nodeType !== 1) continue;
      var ln = localName(c);
      if (ln === 't') {
        tokens.push({ type: 'text', v: c.textContent || '', red: !!fmt.red, bold: !!fmt.bold, underline: !!fmt.underline });
      } else if (ln === 'tab') {
        tokens.push({ type: 'text', v: ' ', red: !!fmt.red });
      } else if (ln === 'br' || ln === 'cr') {
        tokens.push({ type: 'text', v: '\n', red: !!fmt.red });
      } else if (ln === 'sym') {
        var ch = (attr(c, 'w:char') || attr(c, 'char') || '').toUpperCase();
        var font = (attr(c, 'w:font') || attr(c, 'font') || '');
        var letter = symLetter(font, ch) || (UNI_LETTER[c.textContent || ''] || null);
        tokens.push({ type: 'sym', v: ch, font: font, letter: letter, red: !!fmt.red });
      } else if (ln === 'delText' || ln === 'drawing' || ln === 'pict' || ln === 'object') {
        /* 忽略 */
      } else if (ln === 'instrText') {
        /* 忽略 */
      } else {
        collectTokens(c, tokens, fmt);
      }
    }
  }

  /** tokens → HTML（保留粗體／底線，用來仿原卷樣式呈現） */
  function tokensHtml(tokens) {
    var out = '';
    (tokens || []).forEach(function (t) {
      if (t.type === 'text') {
        var s = U.esc(t.v);
        if (t.bold) s = '<b>' + s + '</b>';
        if (t.underline) s = '<u>' + s + '</u>';
        out += s;
      } else if (t.type === 'sym' && t.letter) {
        out += '(' + t.letter + ')';
      }
    });
    return out
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, '  ')
      .replace(/[ ]+\n/g, '\n')
      .replace(/\n[ ]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  /** 遞迴收集（保留文件順序） */
  function collectTokens(node, tokens, red) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType !== 1) continue;
      var ln = localName(c);
      if (ln === 'r') {
        var f = runFmt(c, collectTokens._color);
        if (red && red.red) f.red = true;
        runTokens(c, tokens, f);
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
    /* 保留「2 個以上空白」——那是原卷「填空位置」的線索（例如「第　　　段」），
       收斂成剛好 2 個空白當作標記，其餘空白正規化，避免填空格被吃掉 */
    return s
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, '  ')
      .replace(/[ ]+\n/g, '\n')
      .replace(/\n[ ]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
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

    /* 後備：純文字裡的「A○ B○ C○ D○」或「A、B、C、D」風格（答題簿常見） */
    if (opts.length < 2) {
      var full = tokensText(tokens);
      var m = full.match(/([A-Ha-h])\s*[○●\.)、，]?\s*([A-Ha-h])\s*[○●\.)、，]?\s*([A-Ha-h])\s*[○●\.)、，]?\s*([A-Ha-h])/);
      if (m) {
        opts = [m[1], m[2], m[3], m[4]].map(function (k) {
          return { key: k.toUpperCase(), text: '', red: false };
        });
      }
    }

    return opts
      .map(function (o) {
        return {
          key: o.key,
          text: U.trim(o.text.replace(/[\n\t]+/g, ' ').replace(/\s{2,}/g, ' ')),
          red: !!o.red
        };
      })
      .filter(function (o) { return o.text.length > 0 || /^[A-Ha-h]$/.test(o.key); });
  }

  /** 段落（w:p）→ block */
  function paraBlock(p, color) {
    var tokens = [];
    collectTokens._color = color;
    collectTokens(p, tokens, false);
    var text = U.trim(tokensText(tokens));
    return {
      kind: 'p', node: p, tokens: tokens, text: text,
      html: U.trim(tokensHtml(tokens)),
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
      var ps = [], hasNested = false;
      for (var j = 0; j < tc.childNodes.length; j++) {
        var cc = tc.childNodes[j];
        if (cc.nodeType !== 1) continue;
        if (localName(cc) === 'p') ps.push(cc);
        else if (localName(cc) === 'tbl') hasNested = true;   /* 嵌套表格：expandTable 已自成一列 */
      }
      var toks = [];
      collectTokens._color = color;
      if (ps.length) ps.forEach(function (p) { collectTokens(p, toks, false); });
      else if (!hasNested) collectTokens(tc, toks, false);
      /* 註：儲存格若含嵌套表格，文字由展開後的列負責，這裡不重複收集 */
      var txt = U.trim(tokensText(toks));
      var vis = tokensVisible(toks);
      var symN = tokensSymCount(toks);
      if (tokensRed(toks)) red = true;
      letters = letters.concat(tokensLetters(toks));
      options = options.concat(extractOptions(toks));
      /* 合併儲存格：gridSpan（橫向合併欄數）／vMerge（縱向合併） */
      var span = 1, vmerge = null;
      var tcPr = childByLocal(tc, 'tcPr');
      if (tcPr) {
        var gs = childByLocal(tcPr, 'gridSpan');
        if (gs) {
          var n = parseInt(attr(gs, 'w:val') || attr(gs, 'val') || '1', 10);
          if (n > 1) span = n;
        }
        var vm = childByLocal(tcPr, 'vMerge');
        if (vm) vmerge = attr(vm, 'w:val') || attr(vm, 'val') || 'continue';
      }
      cells.push({
        text: txt,
        html: U.trim(tokensHtml(toks)),
        visible: vis,
        red: tokensRed(toks),
        sym: symN,
        /* 只有符號、沒有文字，且是紅色 → 教師版的勾選記號 */
        tick: tokensRed(toks) && vis === '' && symN > 0,
        letters: tokensLetters(toks),
        span: span,
        vmerge: vmerge
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
  /** 把一個（可能含嵌套表格的）表格展開成 row 區塊。
      嵌套表格＝儲存格裡再放一個表格；配對題／選擇題答題格常這樣排，
      不展開的話整個表格只會剩一格、內容與答案全部擠在一起（實測踩雷）。 */
  function expandTable(tblEl, color, out) {
    for (var j = 0; j < tblEl.childNodes.length; j++) {
      var r = tblEl.childNodes[j];
      if (r.nodeType !== 1 || localName(r) !== 'tr') continue;
      out.push(rowBlock(r, color));
      /* 這一列的儲存格裡若有嵌套表格 → 遞迴展開，排在這一列後面 */
      for (var k = 0; k < r.childNodes.length; k++) {
        var tc = r.childNodes[k];
        if (tc.nodeType !== 1 || localName(tc) !== 'tc') continue;
        for (var m = 0; m < tc.childNodes.length; m++) {
          var nt = tc.childNodes[m];
          if (nt.nodeType === 1 && localName(nt) === 'tbl') expandTable(nt, color, out);
        }
      }
    }
  }

  function buildBlocks(bodyEl, color) {
    var top = [], paras = [];
    for (var i = 0; i < bodyEl.childNodes.length; i++) {
      var c = bodyEl.childNodes[i];
      if (c.nodeType !== 1) continue;
      var ln = localName(c);
      if (ln === 'p') top.push(paraBlock(c, color));
      else if (ln === 'tbl') {
        expandTable(c, color, top);
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

  /* 題號起手：數字 + 一個「內容起頭字元」（中文字 / 《「『“ / 英文字母）。
     許多題目的主幹並沒有（n分）或「？」，但仍是獨立題目，必須被偵測為題號起點，
     否則會被併入上一題，造成「題目被吞掉、表格串味」的顯示錯亂。 */
  var RE_QFIRST = /[《「『“(（\u300a\u300c\u300e\u201cA-Za-z]/;
  var RE_QVERB = /[試回填選判解翻說寫根從比概歸指描請何哪為下分簡陳概答問想想像歸納辨識說明]/;
  function isQStart(b) {
    if (b.kind !== 'p') return false;
    var t = b.text;
    var m = t.match(RE_QNO);
    if (!m) return false;
    if (t.length < 5) return false;
    var c2 = m[2];
    if (!(U.cjk.test(c2) || RE_QFIRST.test(c2))) return false;
    /* 強信號：有分數或問號 */
    if (RE_MARKS.test(t) || t.indexOf('？') >= 0 || t.indexOf('?') >= 0) return true;
    /* 次級信號：去掉題號後的句子開頭含常見「題目指令動詞」 */
    var body = t.replace(RE_QNO_STRIP, '').slice(0, 8);
    if (RE_QVERB.test(body)) return true;
    return false;
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
    return passagesFromBlocks(paras.slice(idx0 + 1, idx1), true);
  }

  /**
   * 從「已排序的區塊陣列」抽出文章。
   * 供純文字／Markdown 來源使用（那些來源沒有 DOM 節點，paras 為空，
   * 用 node 比對的 extractPassages 會永遠回空）。
   * @param {Array} blocks  文章範圍內的區塊（已在文件順序）
   * @param {boolean} skipNestedBlocks  true ＝ 傳進來的已是攤平清單，直接逐段處理
   */
  function passagesFromBlocks(blocks, skipNestedBlocks) {
    var body = [], j;
    for (j = 0; j < blocks.length; j++) {
      var bb = blocks[j];
      if (!bb) continue;
      if (bb.kind === 'tr') {
        /* 表格裡的文章（行號欄＋內文）→ 取最長的儲存格 */
        var best = '', bl = 0;
        (bb.cells || []).forEach(function (c) {
          var v = U.trim(c.visible || c.text || '');
          if (/^\d{1,4}$/.test(v)) return;
          if (v.length > bl) { bl = v.length; best = v; }
        });
        if (bl >= 40) body.push({ text: best, html: U.esc(best) });
        continue;
      }
      if (bb.kind !== 'p') continue;
      body.push(bb);
    }
    return buildPassagesFromList(body);
  }

  /** 逐段組裝文章（與 extractPassages 的規則完全一致） */
  function buildPassagesFromList(list) {
    var out = [], cur = null, inNotes = false, notes = [];
    for (var k = 0; k < list.length; k++) {
      var t = U.trim(list[k].text);
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
      if (!cur) {
        /* 沒有「第X篇」標記 → 自開第一篇（純文字來源常常不寫） */
        cur = { id: 'p1', title: '第一篇', paragraphs: [], notes: [] };
      }
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
    var qs = [], i = from, curPassage = 0, curSection = null;
      while (i < to) {
      var b = blocks[i];
      if (b.kind === 'p' && RE_SECTION.test(b.text)) { curSection = U.trim(b.text).slice(0, 2); i++; continue; }
      if (b.kind === 'p' && b.text.length <= 20 && RE_PASS.test(b.text)) { curPassage++; i++; continue; }
      if (!isQStart(b)) { i++; continue; }

      var no = qno(b);
      var stemRaw = b.text.replace(RE_QNO_STRIP, '');
      var sk = U.stripSkills(stemRaw);
      var q = {
        no: no,
        stem: sk.text,
        skills: sk.skills,
        marks: U.sumMarks(b.text) || 0,
        passageIndex: curPassage,
        section: curSection,
        type: 'text',
        options: [],
        subQuestions: [],
        table: null,
        quotes: [], quotesHtml: [],
        answer: '',
        answerKeys: [],
        explanation: '',
        raw: []
      };

      var j = i + 1, inAnalysis = false;
      while (j < to) {
        var nb = blocks[j];
        /* 遇上「甲部／乙部」等分卷標記必須在此停住，否則會被併入上一題的內容，
           導致分卷標記被跳過、後續題目全被誤歸到前一個 section */
        if (isQStart(nb) || RE_SECTION.test(nb.text) ||
            (nb.kind === 'p' && nb.text.length <= 20 && RE_PASS.test(nb.text))) break;
        /* 純文字／Markdown 來源的答案行（前處理時被轉成「★ …」）：
           這是「這一題的答案」，不是題幹的一部分 → 在此收束，
           但要把「答案行本身」與其後緊接的「答案分析：…」一起吃進來，
           否則解析會落在題目範圍之外而永遠收不到（實測踩雷）。 */
        if (nb.kind === 'p' && RE_MDANS.test(nb.text)) {
          /* 答案行的題號必須和本題一致。純文字／Markdown 的答案常常
             **整批集中在最後**（★ 1. B ／ ★ 3. A），所以遇到「別題的答案」
             不能直接 break（那會連自己的答案都掃不到），要往後找自己的那行。 */
          var abody = U.trim(nb.text.replace(/^[★☆✔✓√☑]\s*/, ''));
          var am = abody.match(/^(\d{1,2})[\s\u3000]*[.、．。)）]?[\s\u3000]*(.*)$/);
          var aNo = am ? parseInt(am[1], 10) : null;
          if (aNo != null && aNo !== no) { j++; continue; }   /* 別題的答案 → 跳過 */
          if (aNo != null) abody = U.trim(am[2]) || abody;
          if (q.mdAnswer) { j++; continue; }                   /* 本題已取過答案 */
          q.mdAnswer = abody;
          var mj = j + 1;
          while (mj < to) {
            var mb = blocks[mj];
            if (mb.kind !== 'p') break;
            var mt = U.trim(mb.text);
            if (!mt) break;
            if (isQStart(mb) || RE_SECTION.test(mb.text) || RE_MDANS.test(mb.text)) break;
            if (RE_ANAL.test(mt)) {
              q.mdExplanation = (q.mdExplanation ? q.mdExplanation + '\n' : '') + mt.replace(RE_ANAL, '');
              mj++; continue;
            }
            if (isRefText(mt)) {
              q.quotes.push(mt);
              q.quotesHtml.push(mb.html || U.esc(mt));
            }
            mj++;
          }
          j = mj;
          continue;
        }

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
            return { text: U.trim(c.text), html: U.trim(c.html || ''), visible: c.visible, red: c.red, tick: c.tick, sym: c.sym, span: c.span || 1, vmerge: c.vmerge || null };
          }));
          q.raw.push('[表] ' + nb.text);
        } else {
          var txt = U.trim(nb.text);
          if (!txt) { j++; continue; }

          /* 引文：給學生看的參考文字，另存為 quotes 單獨呈現 */
          if (isQuoteLike(nb)) { q.quotes.push(txt); q.quotesHtml.push(nb.html || U.esc(txt)); j++; continue; }

          /* 英文選項段落：A. … B. … C. … D. … 接在題幹後 */
          if (isEnglishOption(nb)) {
            var grp = [];
            while (j < to && isEnglishOption(blocks[j])) {
              var ot = U.trim(blocks[j].text);
              var m = ot.match(/^([A-H])[.、)]\s+(.*)$/);
              if (m) grp.push({ key: m[1], text: U.trim(m[2]) });
              j++;
            }
            q.options = q.options.concat(grp);
            continue;
          }

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
          } else if (isRefText(txt)) {
            /* 要解釋的句子／字詞、選項說明等 → 當成參考文字顯示給學生 */
            q.quotes.push(txt);
            q.quotesHtml.push(nb.html || U.esc(txt));
          } else {
            q.raw.push(txt);
          }
        }
        j++;
      }

      /* 表格題：判斷是否為 正確/錯誤/無從判斷 或 True/False/Not Given */
      if (q.table && q.table.rows.length && isTFNG((q.table.rows[0] || []).map(function (c) { return c.text || ''; }))) {
        q.tableType = 'tfng';
      }

      /* 教師版：紅字即答案 */
      if (isTeacher) {
        var reds = [];
        /* 純文字／Markdown 來源：答案與解析在收集階段就被掛上來了 */
        if (q.mdAnswer) reds.push(q.mdAnswer);
        if (q.mdExplanation && !q.explanation) q.explanation = q.mdExplanation;
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

  /* ---------- 英文卷題目收集（題目不帶題號，按「實質段落」切分） ---------- */
  function isBlankLine(t) { return !t || /^[\s\u3000_－\-–—.\u2500]*$/.test(t); }
  function collectEnglish(blocks, from, to, isTeacher) {
    var qs = [], cur = null, n = 0;
    function newQ() {
      n++;
      return { no: n, stem: '', skills: [], marks: 0, passageIndex: 0, section: null,
        type: 'text', options: [], subQuestions: [], table: null, quotes: [], quotesHtml: [],
        answer: '', answerKeys: [], explanation: '', raw: [], _ans: '' };
    }
    for (var i = from; i < to; i++) {
      var b = blocks[i];
      if (b.kind === 'tr') {
        if (!cur) continue;
        cur.table = cur.table || { rows: [] };
        cur.table.rows.push(b.cells.map(function (c) {
          return { text: U.trim(c.text), html: U.trim(c.html || ''), visible: c.visible, red: c.red, tick: c.tick, sym: c.sym, span: c.span || 1, vmerge: c.vmerge || null };
        }));
        if (cur.table.rows.length && isTFNG((cur.table.rows[0] || []).map(function (c) { return c.text || ''; }))) cur.tableType = 'tfng';
        continue;
      }
      if (isEnglishOption(b)) {
        if (!cur) { cur = newQ(); qs.push(cur); }
        var m = U.trim(b.text).match(/^([A-H])[.、)]\s+(.*)$/);
        if (m) cur.options.push({ key: m[1], text: U.trim(m[2]) });
        continue;
      }
      var t = U.trim(b.text);
      if (isBlankLine(t)) continue;
      if (!cur) { cur = newQ(); qs.push(cur); }
      else { cur = newQ(); qs.push(cur); }
      cur.stem = (cur.stem ? cur.stem + '\n' : '') + t;
      cur.marks = cur.marks || U.sumMarks(t);
    }
    return qs;
  }

  /* ============================================================
     表格結構偵測：配對題／表格內選擇題／英文 True-False-Not Given
     ============================================================ */
  var RE_LETTER_CELL = /^[A-H][.、)]?$/;

  function cellText(c) { return U.trim((c && (c.visible || c.text)) || ''); }
  function cellRaw(c) { return U.trim((c && c.text) || ''); }

  /** 配對題：題項＋作答格＋「字母＋選項文字」成列（中英文通用）。
      例：(i) Penny Ma [  ] … A. hardworking */
  function detectMatching(q, t) {
    var rows = (q.table && q.table.rows) || [];
    var tRows = (t && t.table && t.table.rows) || [];
    if (rows.length < 3) return false;
    var options = [], seen = {}, items = [];
    rows.forEach(function (row, ri) {
      var cells = row || [];
      var firstEmpty = -1, letterAt = -1, optText = '';
      for (var c = 0; c < cells.length; c++) {
        var v = cellText(cells[c]);
        if (firstEmpty < 0 && v === '') firstEmpty = c;
        if (RE_LETTER_CELL.test(v)) {
          var nv = cellText(cells[c + 1]);
          if (nv && nv.length >= 2 && !RE_LETTER_CELL.test(nv) && letterAt < 0) { letterAt = c; optText = nv; }
        }
      }
      if (letterAt >= 0 && optText) {
        var key = cellText(cells[letterAt]).replace(/[.、)]$/, '');
        if (!seen[key]) { seen[key] = 1; options.push({ key: key, text: optText }); }
      }
      if (firstEmpty > 0 && (letterAt < 0 || firstEmpty < letterAt)) {
        var label = [];
        for (var c2 = 0; c2 < firstEmpty; c2++) {
          var lv = cellText(cells[c2]);
          if (lv && !RE_LETTER_CELL.test(lv)) label.push(lv);
        }
        if (label.join('').length >= 2) {
          items.push({ id: 'q' + q.no + '_m' + items.length, label: label.join(' '), row: ri, col: firstEmpty });
        }
      }
    });
    if (items.length < 2 || options.length < 3) return false;
    var answers = {};
    items.forEach(function (it) {
      var tv = cellRaw((tRows[it.row] || [])[it.col]);
      if (tv) answers[it.id] = tv.replace(/[.、)]$/, '');
    });
    q.matching = { items: items, options: options, answers: answers };
    q.subQuestions = [];
    q.table = null;
    q.answer = items.map(function (it) {
      var a = answers[it.id] || '';
      var o = options.filter(function (x) { return x.key === a; })[0];
      return (it.label ? it.label + '：' : '') + a + (o ? '. ' + o.text : '');
    }).join('\n');
    return true;
  }

  /** 表格內選擇題：選項全部擠在同一格（A. … B. … C. … D. …）→ 轉成正式 MCQ */
  function detectCellMcq(q) {
    var rows = (q.table && q.table.rows) || [];
    for (var ri = 0; ri < rows.length; ri++) {
      var cells = rows[ri] || [];
      for (var c = 0; c < cells.length; c++) {
        var txt = cellText(cells[c]);
        if ((txt.match(/[A-H][.、)．]/g) || []).length < 3) continue;
        var opts = [];
        splitOptionLine(txt).forEach(function (seg) {
          var m = seg.match(/^\s*([A-H])[.、)．]\s*(.+)$/);
          if (m) opts.push({ key: m[1], text: U.trim(m[2]) });
        });
        if (opts.length >= 3) {
          q.options = opts;
          q.table = null;
          q.subQuestions = [];
          q.mcqFromTable = true;
          return true;
        }
      }
    }
    return false;
  }

  function mapTfngAns(v) {
    var s = U.trim(String(v || '')).toUpperCase();
    if (/^T(RUE)?$/.test(s)) return 'True';
    if (/^F(ALSE)?$/.test(s)) return 'False';
    if (/^(NG|N|NOT GIVEN)$/.test(s)) return 'Not Given';
    return U.trim(v || '');
  }

  /** 英文判斷題：題幹寫明 True (T) / False (F) / Not Given (NG)，表格是敘述＋作答格 */
  function detectTfngEn(q, t) {
    var stem = String(q.stem || '');
    if (!/true\s*\(?\s*t\s*\)?\s*,?\s*false\s*\(?\s*f\s*\)?/i.test(stem) || !/not\s*given/i.test(stem)) return false;
    var rows = (q.table && q.table.rows) || [];
    var tRows = (t && t.table && t.table.rows) || [];
    var subs = [];
    rows.forEach(function (row, ri) {
      var stmt = cellText(row[1]) || cellText(row[0]);
      if (!stmt || stmt.length < 8) return;
      var ans = '';
      var tr = tRows[ri] || [];
      for (var c = 2; c < Math.max(row.length, tr.length); c++) {
        var sv = cellText(row[c]);
        var tv = cellRaw(tr[c]);
        if (tv && !sv) { ans = tv; break; }
      }
      subs.push({
        id: 'q' + q.no + '_' + ri,
        label: cellText(row[0]),
        prompt: stmt,
        choices: ['True', 'False', 'Not Given'],
        answer: mapTfngAns(ans),
        marks: 0,
        kind: 'tfng'
      });
    });
    if (subs.length < 2) return false;
    q._tfngEn = true;
    q.tableType = 'tfng';
    q.subQuestions = subs;
    q.table = null;
    q.answer = subs.map(function (x) {
      return (x.label ? x.label + ' ' : '') + x.prompt + '：' + (x.answer || '—');
    }).join('\n');
    return true;
  }

  /** 題幹相似度：字詞交集比例（英文答案區對位用） */
  function stemSim(a, b) {
    var wa = U.trim(a || '').toLowerCase().split(/\s+/).filter(function (w) { return w.length > 2; });
    var wb = U.trim(b || '').toLowerCase().split(/\s+/).filter(function (w) { return w.length > 2; });
    if (!wa.length || !wb.length) return 0;
    var setb = {};
    wb.forEach(function (w) { setb[w] = 1; });
    var hit = 0;
    wa.forEach(function (w) { if (setb[w]) hit++; });
    return hit / Math.max(wa.length, wb.length);
  }

  /** 英文答案區：教師題的題幹若與某學生題幾乎一樣 → 該教師題成為那一題的答案；
      之後的連續段落（答案內容、『1. B』答案鍵）全部併進去。 */
  function regroupEnglishAnswers(studentQs, teacherQs) {
    var used = {}, holder = null, out = [];
    teacherQs.forEach(function (t) {
      var best = null, bestScore = 0;
      studentQs.forEach(function (q) {
        if (used[q.no]) return;
        var sc = stemSim(t.stem, q.stem);
        if (sc > bestScore) { bestScore = sc; best = q; }
      });
      if (best && bestScore >= 0.45) {
        used[best.no] = 1;
        t.no = best.no;
        t._plainBody = [];
        holder = t;
        out.push(t);
      } else if (holder) {
        var a = U.trim(t.stem || '');
        if (a) holder._plainBody.push(a);
      }
    });
    return out;
  }

  /** 取「較完整」的儲存格文字（填充題要有底線，visible 可能會濾掉） */
  function cellRich(c) {
    var t = U.trim((c && c.text) || '');
    var v = cellText(c);
    return t.length >= v.length ? t : v;
  }

  /** 空白正規化（連續空白收成 1 個），並保留「正規化位置 → 原始位置」對照 */
  function normWithMap(t) {
    var out = '', map = [], prevSpace = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (/[\s\u3000]/.test(ch)) {
        if (prevSpace) continue;
        prevSpace = true; out += ' ';
      } else { prevSpace = false; out += ch; }
      map.push(i);
    }
    map.push(t.length);
    return { s: out, map: map };
  }

  /**
   * 摘要／筆記填充題：整段文字放在一格裡，空格用「(a) ______」表示。
   * 學生版有底線、教師版把答案填在同一位置。
   * 取答案的方式是「對齊兩份文字」：以空白前後的文字當錨點，
   * 教師版在兩個錨點之間多出來的字就是答案（不是取到下一個空格為止，
   * 否則會把整句尾都當成答案 —— 實測踩過）。
   */
  function detectInlineBlanks(q, t) {
    var rows = (q.table && q.table.rows) || [];
    if (!rows.length) return false;
    var sText = rows.map(function (r) {
      return (r || []).map(cellRich).filter(Boolean).join('  ');
    }).join('\n');
    var tRows = (t && t.table && t.table.rows) || [];
    var tText = tRows.map(function (r) {
      return (r || []).map(cellRich).filter(Boolean).join('  ');
    }).join('\n');
    if (!tText) return false;

    var sN = normWithMap(sText), tN = normWithMap(tText);
    var RE_BLANK = /\(([a-z0-9]{1,3})\)[\s\u3000]*(?:_{2,}|＿{2,}|\.{3,}|—{2,})/g;
    var marks = [], m;
    while ((m = RE_BLANK.exec(sN.s))) marks.push({ key: m[1], ms: m.index, me: m.index + m[0].length });
    if (marks.length < 2) return false;

    var cursorN = 0, blanks = [];
    marks.forEach(function (mk) {
      var head = '(' + mk.key + ')';
      var anchor = sN.s.slice(Math.max(0, mk.ms - 26), mk.ms + head.length);
      var ap = tN.s.indexOf(anchor, Math.max(0, cursorN - 26));
      if (ap < 0) ap = tN.s.indexOf(anchor);
      var startN;
      if (ap >= 0) startN = ap + anchor.length;
      else {
        var hp = tN.s.indexOf(head, cursorN);
        if (hp < 0) return;
        startN = hp + head.length;
      }
      /* 空白之後的文字（錨點）：在教師版裡找出同一段文字，兩者之間就是答案 */
      /* 錨點不可包含底線（學生版的空白在教師版沒有底線，會找不到） */
      var tail = sN.s.slice(mk.me, mk.me + 30).split(/[_＿]/)[0];
      var endN = -1;
      if (tail.replace(/\s/g, '').length >= 4) endN = tN.s.indexOf(tail, startN);
      if (endN < 0) {
        var nextHead = null;
        for (var k = 0; k < marks.length; k++) if (marks[k].ms > mk.ms) { nextHead = '(' + marks[k].key + ')'; break; }
        if (nextHead) endN = tN.s.indexOf(nextHead, startN);
      }
      if (endN < 0) endN = tN.s.length;
      var ans = U.trim(tText.slice(tN.map[Math.min(startN, tN.map.length - 1)],
        tN.map[Math.min(endN, tN.map.length - 1)]))
        .replace(/^[\s\u3000.．、:：_＿\-–—]+/, '')
        .replace(/[\s\u3000]+$/, '')
        .trim();
      /* 依題幹的「ONE word / TWO words」限制字數（多出來的是句尾，不是答案） */
      var want = /one word/i.test(q.stem) ? 1 : (/two words/i.test(q.stem) ? 2 : (/three words/i.test(q.stem) ? 3 : 0));
      if (want) {
        var ws = ans.split(/[\s\u3000]+/).filter(Boolean);
        if (ws.length > want) ans = ws.slice(0, want).join(' ');
      } else if (ans.length > 40) {
        ans = ans.split(/[\s\u3000]+/).slice(0, 3).join(' ');
      }
      cursorN = endN;
      blanks.push({
        key: mk.key, id: 'q' + q.no + '_blk_' + mk.key,
        label: '(' + mk.key + ')', answer: ans, marks: 0
      });
    });
    if (blanks.filter(function (b) { return b.answer; }).length < 2) return false;

    q._fillin = true;
    q.fillin = { text: sText, blanks: blanks };
    q.subQuestions = blanks.map(function (b) {
      return { id: b.id, label: b.label, prompt: '', answer: b.answer, marks: b.marks, kind: 'fill' };
    });
    q.answer = blanks.map(function (b) { return b.label + ' ' + (b.answer || '—'); }).join('\n');
    return true;
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

      /* 表格結構偵測（配對題／表格內選擇題／英文判斷題）→ 先於一般 diff 轉換題型 */
      if (q.type === 'table') {
        if (detectMatching(q, t)) q.type = 'matching';
        else if (detectCellMcq(q)) q.type = 'mcq';
        else if (detectTfngEn(q, t)) { /* tableType 已設，subs 已建 */ }
        else if (detectInlineBlanks(q, t)) { /* 摘要填充：subs 已建，逐格抽答案 */ }
      }
      if (q.type === 'matching') {
        q.answer = (q.matching.items || []).map(function (it) {
          var a = q.matching.answers[it.id] || '';
          var o = q.matching.options.filter(function (x) { return x.key === a; })[0];
          return (it.label ? it.label + '：' : '') + a + (o ? '. ' + o.text : '');
        }).join('\n');
        return;
      }
      if (!t) { q._warn = '教師版找不到第 ' + q.no + ' 題'; return; }

      /* 答案文字：優先紅字，其次教師版題目後的所有文字 */
      var ansList = (t._redAnswers && t._redAnswers.length) ? t._redAnswers.slice() : [];
      if (!ansList.length) {
        ansList = (t._plainBody || []).filter(function (x) {
          return !RE_REF.test(x) && !RE_ANAL.test(x);
        });
      }
      /* 純文字／Markdown 匯入時，答案行後面常常緊接著「答案分析：…」；
         那行已經被收進 explanation，不要再當成答案。
         （不加這一步的話 q.explanation 先被清掉，答案反而變成整句解析） */
      if (t.explanation) {
        var exSet = {};
        String(t.explanation).split('\n').forEach(function (x) {
          var k = U.trim(x).replace(/^[★☆✔✓√☑]\s*/, '');
          if (k) exSet[k] = 1;
        });
        ansList = ansList.filter(function (x) { return !exSet[U.trim(x)]; });
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
        /* 英文卷：答案區的紅字可能是單一字母（A/B/C/D） */
        if (!keys.length && t._redAnswers) {
          var single = t._redAnswers.filter(function (x) { return /^[A-Ha-h]$/.test(U.trim(x)); })
            .map(function (x) { return x.toUpperCase(); });
          if (single.length) keys = single;
        }
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

      if (q.type === 'table' && !q._tfngEn && !q._fillin) buildSubQuestions(q, t);
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
    /* 純文字／Markdown 匯入最常見的形式：整行就是「3. B」或只有「B」。
       ① 「n. X」→ 取 X（選擇題的答案鍵）
       ② 整行只有一個字母 → 就是答案 */
    if (!keys.length) {
      var lines = s.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var ln = U.trim(lines[i]);
        if (!ln) continue;
        var lm = ln.match(/^\d{1,2}[\s\u3000]*[.、．。)）]?[\s\u3000]*([A-Ha-h])[\s\u3000]*[.、．。)）]?[\s\u3000]*$/);
        if (lm) { keys = [lm[1].toUpperCase()]; break; }
      }
      if (!keys.length) {
        for (var j = 0; j < lines.length; j++) {
          var l2 = U.trim(lines[j]);
          var sm = l2.match(/^[\(（]?([A-Ha-h])[\)）]?[\s\u3000]*$/);
          if (sm) { keys = [sm[1].toUpperCase()]; break; }
        }
      }
    }
    return keys
      .filter(function (k) { return bad.indexOf(k) < 0; })
      .filter(function (k, i, a) { return a.indexOf(k) === i; })
      .sort();
  }

  function subLabel(rowLabel, seq) {
    rowLabel = U.trim(rowLabel || '');
    seq = U.trim(seq || '');
    if (!rowLabel) return seq;
    /* rowLabel 本身常已含「(1)」等序號，別再重複附加 */
    if (!seq || rowLabel.indexOf(seq) === 0) return rowLabel.replace(/\s+/g, ' ');
    return (rowLabel + ' / ' + seq).replace(/\s+/g, ' ');
  }

  function buildSubQuestions(q, t) {
    var sRows = (q.table && q.table.rows) || [];
    var tRows = (t.table && t.table.rows) || [];
    var subs = [];
    /* 標題列：教師版第一列（通常是欄位名稱，如「肖像描寫／正確／錯誤」） */
    var tHead = tRows[0] || sRows[0] || [];
    var header = tHead.map(function (c) { return U.trim(c.text || ''); });

    var n = Math.max(sRows.length, tRows.length);
    var lastSub = null, prevLabel = '', prevRow = null;
    for (var r = 0; r < n; r++) {
      var sr = sRows[r] || [], tr = tRows[r] || [];
      var rowLabel = U.trim((sr[0] && sr[0].text) || (tr[0] && tr[0].text) || '');
      var seq = (String(rowLabel).match(/^[\(（]\d+[\)）]/) || [])[0] || '';
      var cn = Math.max(sr.length, tr.length);
      var tickSeen = false;
      var subsLenBefore = subs.length;

      /* 「字數格子列」：學生版整列都是空格（原卷給 N 個小格限制字數）、
         教師版在格子裡逐字填答案 → 併回上一題項的子題（答案合成一個詞），
         不要逐格建子題（答案會變得支離破碎） */
      var sAllEmpty = sr.length && sr.every(function (c) { return !U.trim((c && c.text) || ''); });
      var tJoined = tr.map(function (c) { return U.trim((c && c.text) || ''); }).join('');
      if (sAllEmpty && tJoined) {
        if (lastSub) {
          if (lastSub.answer.indexOf(tJoined) < 0) lastSub.answer = U.trim((lastSub.answer || '') + tJoined);
          lastSub.boxes = tr.length;
        } else if (prevLabel) {
          /* 教師版答案全在嵌套格子裡（外層格是空的）→ 用上一列的敘述當標籤；
             子題 id 指回上一列的作答格，學生的輸入框才對得到這個子題 */
          var pe = -1;
          (prevRow || []).forEach(function (c, ci) {
            if (pe < 0 && !U.trim((c && c.text) || '')) pe = ci;
          });
          if (pe < 0) pe = 0;
          lastSub = {
            id: 'q' + q.no + '_' + (r - 1) + '_' + pe,
            label: prevLabel, prompt: '',
            answer: tJoined, marks: 0, kind: 'fill', boxes: tr.length
          };
          subs.push(lastSub);
        }
        continue;   /* 這一列不逐格建子題 */
      }

      /* 真／假／無從判斷：首列為題幹，正確欄位由教師版紅字標記 */
      if (q.tableType === 'tfng' && r > 0) {
        var ansIdx = -1;
        for (var c0 = 0; c0 < cn; c0++) {
          if (tr[c0] && tr[c0].red && c0 > 0) { ansIdx = c0; break; }
          if (tr[c0] && tr[c0].tick && c0 > 0) { ansIdx = c0; break; }
        }
        subs.push({
          id: 'q' + q.no + '_' + r,
          label: seq || rowLabel || ('第 ' + r + ' 列'),
          prompt: (sr[0] ? U.trim(sr[0].visible || sr[0].text) : '') || rowLabel,
          choices: header,
          answer: ansIdx >= 0 ? (header[ansIdx] || '') : '',
          marks: 0,
          kind: 'tfng'
        });
        continue;
      }

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
            label: seq || ('第 ' + (r + 1) + ' 列'),
            prompt: rowLabel,
            /* 讓學生能從欄位標題中挑一個（例：肖像描寫／語言描寫／行動描寫／心理描寫） */
            choices: header.slice(1).filter(function (x) { return U.trim(x); }),
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
      /* 敘述列（非空格列）若沒建出子題 → 重置群組，下一個格子列自成一組 */
      if (!sAllEmpty) {
        lastSub = (subs.length > subsLenBefore) ? subs[subs.length - 1] : null;
      }
      if (rowLabel) prevLabel = rowLabel;
      prevRow = sr.length ? sr : tr;
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

    /**
     * 把「純文字行」轉成解析器內部使用的 block，讓 PDF／純文字來源
     * 也能吃到完全一樣的題號偵測、選項抽取、引文擷取與分卷邏輯。
     * @param {Array<string>} lines
     * @param {Object} opt {red:false}
     */
    splitOptionLine: splitOptionLine,

    blocksFromLines: function (lines, opt) {
      opt = opt || {};
      var out = [];
      (lines || []).forEach(function (line) {
        splitOptionLine(line).forEach(function (one) {
          var t = U.trim(one);
          if (t === '') {
            out.push({ kind: 'p', node: null, tokens: [], text: '', html: '', red: false, letters: [], options: [] });
            return;
          }
          var tokens = [{ type: 'text', v: t, red: !!opt.red }];
          var opts = extractOptions(tokens);
          /* 純文字／Markdown 的選項是「A. 文字」而不是 Wingdings 符號，
             extractOptions 只認符號 → 這裡補上「行首字母＋分隔符」的辨識，
             否則整組選項會被當成題幹文字而消失。 */
          if (!opts.length) {
            var om = t.match(/^[\(（]?([A-H])[\)）]?\s*[.、)．:：]\s*(\S[\s\S]*)$/);
            if (!om) om = t.match(/^[\(（]([A-H])[\)）]\s*(\S[\s\S]*)$/);
            if (om && U.trim(om[2])) opts = [{ key: om[1], text: U.trim(om[2]), red: !!opt.red }];
          }
          out.push({
            kind: 'p', node: null, tokens: tokens,
            text: t, html: U.esc(t),
            red: !!opt.red,
            letters: tokensLetters(tokens),
            options: opts
          });
        });
      });
      return out;
    },

    parseXML: function (xml, color, fileName) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var perr = doc.getElementsByTagName('parsererror');
      if (perr && perr.length) throw new Error('XML 解析失敗');

      var bodyEl = doc.getElementsByTagName('w:body')[0] ||
                   doc.getElementsByTagName('body')[0];
      if (!bodyEl) throw new Error('找不到文件主體');

      var built = buildBlocks(bodyEl, color);
      return Docx.fromBlocks(built.top, built.paras, { answerColor: color, fileName: fileName });
    },

    /**
     * 把「已建構好的 blocks」變成試卷 —— 供 PDF 等非 docx 來源重用同一套出題邏輯。
     * @param {Array} top   區塊陣列 [{kind:'p'|'tr', text, html, tokens, cells,…}]
     * @param {Array} paras 段落節點（PDF 沒有可傳 []）
     * @param {Object} opt  {fileName, answerColor, lang, mode}
     */
    fromBlocks: function (top, paras, opt) {
      opt = opt || {};
      var color = opt.answerColor || 'FF0000';
      var fileName = opt.fileName || '';
      top = top || []; paras = paras || [];
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
      var isEnglish = opt.lang ? (opt.lang === 'en') : top.some(function (b) {
        return /Suggested Answers|Reading Text|END OF READING TEXT|END OF QUESTIONS/i.test(b.text || '');
      });
      var lang = opt.lang || (isEnglish ? 'en' : 'zh');

      var matIdx = findIndex(top, function (b) {
        return isShort(b) && /閱\s*讀\s*能\s*力\s*考\s*材/.test(b.text);
      });
      if (!isEnglish && matIdx < 0) {
        warnings.push('找不到「閱讀能力考材」標題，文章可能闕漏，請檢查。');
      }

      /* ---- 文章 ---- */
      var passages = [];
      if (isEnglish) {
        var rStart = findIndex(top, function (b) { return /^\s*Reading Text\s*$/i.test(b.text); });
        var rEnd = findIndex(top, function (b, k) { return k > rStart && /^END OF READING TEXT/i.test(b.text); });
        if (rStart >= 0 && rEnd > rStart) {
          passages = extractEnglishArticle(top, rStart, rEnd);
        } else {
          /* 文章包在表格裡（行號欄＋內文，無 Reading Text 標記）→
             取「長段落格」併成文章（行號邊欄略過） */
          var art = [];
          top.forEach(function (b) {
            if (b.kind !== 'tr' || art.length > 80) return;
            var best = '', bestLen = 0;
            (b.cells || []).forEach(function (c) {
              var v = U.trim(c.text || '');
              if (/^\d{1,4}$/.test(v)) return;
              if (v.length > bestLen) { bestLen = v.length; best = v; }
            });
            if (bestLen >= 50) art.push(best);
          });
          if (art.join('').replace(/\s/g, '').length > 300) {
            passages = [{ id: 'p1', title: 'Reading Text', text: art.join('\n') }];
          }
        }
      } else if (matIdx >= 0) {
        var doneIdx = findIndex(top, function (b, k) { return k > matIdx && isShort(b) && RE_DONE.test(b.text); });
        if (doneIdx < 0) {
          doneIdx = findIndex(top, function (b, k) { return k > matIdx && isShort(b) && /語\s*譯/.test(b.text); });
        }
        var endNode = doneIdx > 0 ? top[doneIdx].node : null;
        passages = extractPassages(paras, top[matIdx].node, endNode);
        /* 純文字／Markdown 來源沒有 DOM 節點（node 為 null）→
           extractPassages 用 node 比對會找不到，改用「位置切片」。 */
        if (!passages.length) {
          var cut = doneIdx > matIdx ? doneIdx : top.length;
          /* 「第X篇」是文章內的分段標記，不是「文章結束」→ 只到「－完－」為止 */
          if (doneIdx < 0) {
            var stopIdx = findIndex(top, function (b, k) { return k > matIdx && isShort(b) && RE_END.test(b.text); });
            if (stopIdx > matIdx) cut = stopIdx;
          }
          passages = passagesFromBlocks(top.slice(matIdx + 1, cut));
          if (passages.length) passages.forEach(function (p, pi) { p.id = 'p' + (pi + 1); });
        }
      }
      if (!passages.length) {
        warnings.push('未能擷取文章，請在上傳後手動貼上或修正。');
      }

      /* ---- 學生版題目 ---- */
      /* 英文卷區段：建議答案／Annotated Text 的「最後一次」出現（避開目錄條目） */
      var enSugStart = -1, enSugEnd = -1, enAnnStart = -1, enEndQ = -1;
      if (isEnglish) {
        top.forEach(function (b, i) {
          var tt = U.trim(b.text || '');
          if (/suggested answers/i.test(tt) && !/^end of/i.test(tt)) enSugStart = i;   /* 不抓 END 那行 */
          if (/^end of suggested answers/i.test(tt) && enSugEnd < 0) enSugEnd = i;
          if (/^annotated text/i.test(tt) && tt.length <= 30) enAnnStart = i;
          if (/^end of questions/i.test(tt)) enEndQ = i;
        });
      }
      var sFrom, sEnd;
      if (isEnglish) {
        sFrom = findIndex(top, function (b) { return /^\s*Questions\s*$/i.test(b.text); });
        if (sFrom < 0) sFrom = 0;
        /* 學生卷到「END OF QUESTIONS／建議答案／Annotated Text」為止。
           Annotated Text 一律不採用（老師指定：不用加進試卷） */
        var limits = [];
        if (enEndQ >= 0) limits.push(enEndQ);
        if (enSugStart > 10 && (enSugEnd > enSugStart || enSugStart > top.length * 0.3)) limits.push(enSugStart);
        if (enAnnStart > 10) limits.push(enAnnStart);
        sEnd = limits.length ? Math.min.apply(null, limits) : top.length;
        if (sEnd <= sFrom) sEnd = top.length;
      } else {
        /* 從最前面開始掃，才能吃到「甲部」標記與甲部題目（含 答題簿 格式） */
        sFrom = 0;
        sEnd = findIndex(top, function (b, k) { return k >= sFrom && isShort(b) && RE_END.test(b.text); });
        if (sEnd < 0) sEnd = top.length;
        /* 純文字／Markdown 來源：文章與題目的先後順序和紙本一樣時，
           「－完－」只代表「文章結束」，後面還有題目（甚至還有第二篇文章），
           所以要把結束點往後推到真正的教師版／試卷完，否則題目會全部消失。 */
        if (sEnd < top.length) {
          var afterEnd = top.slice(sEnd + 1);
          var hasMore = afterEnd.some(function (b2) {
            return (b2.kind === 'p' && isQStart(b2)) ||
              (b2.kind === 'p' && b2.text.length <= 20 && RE_PASS.test(b2.text)) ||
              (b2.kind === 'p' && RE_SECTION.test(b2.text));
          });
          if (hasMore) {
            var hardEnd = findIndex(top, function (b, k) {
              return k > sEnd && b.kind === 'p' && isShort(b) &&
                (RE_END.test(b.text) || RE_DONE.test(b.text) || RE_MDANS.test(b.text));
            });
            sEnd = hardEnd > sEnd ? hardEnd : top.length;
          }
        }
      }
      var studentQs = isEnglish
        ? collectEnglish(top, sFrom + 1, sEnd, false)
        : collectQuestions(top, sFrom, sEnd, false);

      /* ---- 教師版題目 ---- */
      var teacherQs = [];
      if (isEnglish) {
        /* 只掃「建議答案」區段；Annotated Text 一律不用（答案不在裡面） */
        if (enSugStart > 10 && (enSugEnd > enSugStart || enSugStart > top.length * 0.3)) {
          var tEndEn = enSugEnd > enSugStart ? enSugEnd
            : (enAnnStart > enSugStart ? enAnnStart : top.length);
          teacherQs = collectEnglish(top, enSugStart + 1, tEndEn, true);
        }
      } else if (teacherIdx >= 0) {
        var tFrom = findIndex(top, function (b, k) { return k >= teacherIdx && isShort(b) && RE_PASS.test(b.text); });
        if (tFrom < 0) tFrom = teacherIdx;
        var tEnd = findIndex(top, function (b, k) { return k > tFrom && isShort(b) && RE_END.test(b.text); });
        if (tEnd < 0) tEnd = top.length;
        teacherQs = collectQuestions(top, tFrom, tEnd, true);
      } else if (top.some(function (b) { return b.kind === 'p' && RE_MDANS.test(b.text); })) {
        /* 純文字／Markdown 來源：答案用「★ 3. B」逐題標在題目後面，
           沒有傳統的「教師版」大區段 → 讓整個範圍都當教師版掃，
           collectQuestions 只會撿走 ★ 行，題幹不會被誤認成答案。 */
        teacherQs = collectQuestions(top, sFrom, sEnd, true);
      } else {
        warnings.push('找不到「教師版」區段：本卷可能只有學生版，答案需自行填寫或另外上傳教師卷。');
      }

      /* ---- 英文卷：把答案區的教師題對位回學生題 ----
         作法：教師題的題幹與哪一題學生題最像，就當成那一題的「答案持有者」；
         之後連續的答案段落（或『1. B』這種答案鍵）全部併進持有者。
         表格型教師題（配對／判斷／填充）同樣靠題幹對位，
         mergeVersions 內再以儲存格差異抓答案。 */
      if (isEnglish && teacherQs.length) {
        teacherQs = regroupEnglishAnswers(studentQs, teacherQs);
      }

      /* ---- 合併 ---- */
      var questions = mergeVersions(studentQs, teacherQs);

      /* ---- 篇章指派 ---- */
      questions.forEach(function (q) {
        if (q.section === '甲' || !passages.length) { q.passageId = null; return; }
        var pi = Math.min(Math.max(q.passageIndex, 1), passages.length || 1) - 1;
        q.passageId = passages[pi] ? passages[pi].id : null;
      });

      /* ---- 後處理 ---- */
      questions.forEach(function (q) {
        q.id = 'q' + q.no;
        /* 段落劃分／概括題：不適合線上作答 → 標記略過（老師可於編輯頁恢復） */
        if (isSectionSplitQ(q)) { q.skip = true; q.skipReason = '段落劃分／概括題'; }
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
      var nSkip = questions.filter(function (q) { return q.skip; }).length;
      if (nSkip) warnings.push('已略過 ' + nSkip + ' 題「段落劃分／概括題」（不適合線上作答；可在編輯頁逐題恢復）');

      var totalMarks = questions.reduce(function (a, q) { return a + (q.marks || 0); }, 0);

      var level = '';
      var lm = title.match(/(中[一二三四五六]|小[一二三四五六])/);
      if (lm) level = lm[1];

      return {
        title: title,
        level: level,
        lang: lang,
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
