/* ============================================================
   pdf-parser.js —— PDF 試卷解析
   ------------------------------------------------------------
   兩條路徑：
   ① 有文字層（電子 PDF）→ 抽出文字行，交給 docx-parser 的同一套出題邏輯
      （題號偵測、選項抽取、引文、分卷…全部共用）。
   ② 沒有文字層（掃描 PDF，例如影印的數學卷）→ 逐頁轉成圖片，
      建立「每頁一題、顯示原頁截圖、可用通用作答框作答」的題目。
   PDF 無法「無中生有」文字；掃描卷沒有文字層是檔案本身的性質，不是程式問題。
   ============================================================ */
(function () {
  var RQ = window.RQ = window.RQ || {};
  var U = RQ.util;

  /* 有文字層的最低門檻：平均每頁至少這麼多字才算「電子 PDF」 */
  var MIN_CHARS_PER_PAGE = 30;

  function hasLib() { return typeof pdfjsLib !== 'undefined'; }

  /**
   * pdf.worker 的路徑要跟 pdf.min.js 放在一起 —— 不能寫死相對路徑，
   * 否則測試頁放在 tools/ 底下時會去找 tools/assets/...（實測踩過）。
   * 這裡從頁面上實際載入的 <script src="…/pdf.min.js"> 推算同目錄的 worker。
   */
  function workerUrl() {
    var ss = (typeof document !== 'undefined' && document.getElementsByTagName('script')) || [];
    for (var i = 0; i < ss.length; i++) {
      var src = ss[i].getAttribute('src') || '';
      if (/pdf(\.min)?\.js$/i.test(src)) return src.replace(/pdf(\.min)?\.js$/i, 'pdf.worker.min.js');
    }
    return 'assets/js/lib/pdf.worker.min.js';
  }

  function readyWorker() {
    if (!hasLib()) throw new Error('缺少 pdf.js 函式庫（assets/js/lib/pdf.min.js），無法解析 PDF');
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl();
    }
    return true;
  }

  function toBuffer(input) {
    if (typeof File !== 'undefined' && input instanceof File) return U.readFileAsArrayBuffer(input);
    if (input instanceof ArrayBuffer) return Promise.resolve(input);
    if (input && input.buffer instanceof ArrayBuffer) return Promise.resolve(input.buffer);
    return Promise.resolve(input);
  }

  function open(input) {
    return toBuffer(input).then(function (buf) {
      readyWorker();
      /* 一定要複製一份 Uint8Array：pdf.js 會接管 buffer，之後我們還要再用 */
      return pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    });
  }

  /* ---------- 文字層：把文字項目併成「行」 ---------- */
  function itemsToLines(items) {
    var rows = [];
    (items || []).forEach(function (it) {
      var str = (it && it.str) || '';
      if (!str.trim()) return;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var x = tr[4], y = tr[5];
      var h = Math.abs(tr[3]) || it.height || 10;
      var tol = Math.max(2, h * 0.45);
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        if (Math.abs(rows[i].y - y) <= tol) { row = rows[i]; break; }
      }
      if (!row) { row = { y: y, h: h, items: [] }; rows.push(row); }
      row.items.push({ x: x, str: str, w: it.width || 0 });
    });

    rows.sort(function (a, b) { return b.y - a.y; });   /* 上 → 下 */

    return rows.map(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
      var txt = '', prevEnd = null, prevH = r.h;
      r.items.forEach(function (it) {
        if (prevEnd != null && it.x > prevEnd + 1) {
          var gap = it.x - prevEnd;
          /* 大空隙＝原卷的填空位置 → 用 2 個空白標記（與 docx 解析器的約定一致）；
             一般字距則補 1 個空白，避免中文字被拆開。 */
          txt += (gap > prevH * 1.6) ? '  ' : (/[A-Za-z0-9]$/.test(txt) ? ' ' : '');
        }
        txt += it.str;
        prevEnd = it.x + (it.w || 0);
      });
      return U.trim(txt).replace(/ {3,}/g, '  ');
    }).filter(function (t) { return t !== ''; });
  }

  function pageText(pdf, i) {
    return pdf.getPage(i + 1).then(function (page) {
      return page.getTextContent();
    }).then(function (tc) {
      return itemsToLines(tc.items);
    }).catch(function () { return []; });
  }

  /* ---------- 掃描檔：把一頁畫成 JPEG dataURL ---------- */
  function pageImage(pdf, i, opt) {
    return pdf.getPage(i + 1).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var maxW = opt.maxWidth || 1150;
      var scale = Math.min(opt.maxScale || 2.0, maxW / base.width);
      if (!(scale > 0.2)) scale = 0.2;
      if (!(scale < 6)) scale = 6;
      var vp = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      var ctx = canvas.getContext('2d');
      /* JPEG 不支援透明 → 先鋪白，否則掃描頁會變黑 */
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        return canvas.toDataURL('image/jpeg', opt.quality || 0.72);
      });
    });
  }

  function metaTitle(pdf, fileName) {
    return pdf.getMetadata().then(function (m) {
      var t = m && m.info && (m.info.Title || '');
      t = U.trim(t || '');
      if (t && t.length <= 60 && !/^untitled|^microsoft word|^document/i.test(t)) return t;
      return '';
    }).catch(function () { return ''; });
  }

  /* ---------- 主程式 ---------- */
  var Pdf = {
    available: hasLib,

    /** 快速探測：有幾頁、有沒有文字層（上載頁用來提示老師會走哪條路） */
    probe: function (input) {
      return open(input).then(function (pdf) {
        var n = pdf.numPages, jobs = [];
        var sample = Math.min(n, 3);
        for (var i = 0; i < sample; i++) jobs.push(pageText(pdf, i));
        return Promise.all(jobs).then(function (all) {
          var chars = all.reduce(function (a, lines) {
            return a + lines.join('').replace(/\s/g, '').length;
          }, 0);
          var per = chars / (sample || 1);
          return {
            pageCount: n,
            textChars: chars,
            mode: per >= MIN_CHARS_PER_PAGE ? 'text' : 'image',
            sampledPages: sample
          };
        });
      });
    },

    /**
     * @param {File|ArrayBuffer} input
     * @param {Object} opt {fileName, maxWidth, quality, forceMode:'text'|'image'|'auto',
     *                      lang:'zh'|'en', maxPages}
     * @returns {Promise} 與 Docx.parse 相同的形狀（另外多 mode / pages）
     */
    parse: function (input, opt) {
      opt = opt || {};
      var fileName = opt.fileName || '';
      var warnings = [];

      return open(input).then(function (pdf) {
        var n = pdf.numPages;
        var maxPages = opt.maxPages || 30;
        var usePages = Math.min(n, maxPages);
        if (n > maxPages) warnings.push('PDF 共 ' + n + ' 頁，只處理前 ' + maxPages + ' 頁。');

        /* 先抽文字，決定走哪條路 */
        var textJobs = [];
        for (var i = 0; i < usePages; i++) textJobs.push(pageText(pdf, i));
        return Promise.all(textJobs).then(function (pageLines) {
          var charCount = pageLines.join('').replace(/\s|\u3000/g, '').length;
          var perPage = charCount / (usePages || 1);
          var mode = opt.forceMode && opt.forceMode !== 'auto'
            ? opt.forceMode
            : (perPage >= MIN_CHARS_PER_PAGE ? 'text' : 'image');
          return metaTitle(pdf, fileName).then(function (meta) {
            return mode === 'image'
              ? buildImageQuiz(pdf, usePages, fileName, warnings, opt, meta)
              : buildTextQuiz(pageLines, usePages, fileName, warnings, opt, meta);
          });
        });
      }).catch(function (e) {
        throw new Error('PDF 解析失敗：' + ((e && e.message) || e));
      });
    }
  };

  /* ---------- ① 文字層 PDF → 共用出題邏輯 ---------- */
  function buildTextQuiz(pageLines, pageCount, fileName, warnings, opt, metaTitleStr) {
    var lines = [];
    pageLines.forEach(function (ls, pi) {
      ls.forEach(function (t) { lines.push(t); });
      if (pi < pageLines.length - 1) lines.push('');   /* 頁與頁之間留一個空行 */
    });

    var blocks = RQ.docx.blocksFromLines(lines);
    if (!blocks.length) {
      warnings.push('PDF 有文字層但抽不到任何文字行，請改用「掃描檔模式」上傳。');
    }

    var base = RQ.docx.fromBlocks(blocks, [], {
      fileName: fileName,
      answerColor: opt.answerColor || 'FF0000',
      lang: opt.lang || ''
    });

    var title = U.trim(base.title || '');
    if (!title || title.length > 40 || !/試卷|考卷|測驗|評估|試題/.test(title)) {
      var m = U.trim(String(fileName || '').replace(/\.[a-z0-9]+$/i, ''));
      if (m) title = m;
      if (metaTitleStr) title = metaTitleStr || title;
    }

    base.title = title.slice(0, 40) || '未命名試卷';
    base.level = U.guessLevel(base.title) || U.guessLevel(fileName) || base.level || '';
    base.subject = U.guessSubject(base.title) || U.guessSubject(fileName) || '';
    base.mode = 'text';
    base.pageCount = pageCount;
    base.source = fileName || '';
    base.warnings = warnings.concat(base.warnings || []);
    base.stats = Object.assign({}, base.stats, { pdfMode: 'text', pages: pageCount, textChars: lines.join('').length });
    return base;
  }

  /* ---------- ② 掃描 PDF → 每頁一題（原頁截圖） ---------- */
  function buildImageQuiz(pdf, pageCount, fileName, warnings, opt, metaTitleStr) {
    var jobs = [];
    for (var i = 0; i < pageCount; i++) jobs.push(pageImage(pdf, i, opt));
    return Promise.all(jobs).then(function (images) {
      var questions = images.map(function (src, i) {
        return {
          no: i + 1,
          id: 'q' + (i + 1),
          type: 'text',
          stem: '第 ' + (i + 1) + ' 頁：請依題號作答',
          marks: 0,
          section: null,
          passageIndex: 0,
          passageId: null,
          options: [],
          subQuestions: [],
          table: null,
          quotes: [],
          quotesHtml: [],
          answer: '',
          answerKeys: [],
          explanation: '',
          image: src,
          imageOnly: true,
          fromPdfPage: i + 1
        };
      });

      var title = U.trim(metaTitleStr || '') ||
        U.trim(String(fileName || '').replace(/\.[a-z0-9]+$/i, '')) || '未命名試卷';

      warnings.push('這個 PDF 沒有文字層（掃描／影印檔），已改為「每頁一題、顯示原頁截圖」。' +
        '學生會看到原卷畫面，在下方作答框作答；你也可以在編輯頁把每頁的截圖附加到各題，或直接在圖片上出題。');

      return {
        title: title.slice(0, 40),
        level: U.guessLevel(title) || U.guessLevel(fileName) || '',
        subject: U.guessSubject(title) || U.guessSubject(fileName) || '',
        lang: /[\u4e00-\u9fff]/.test(title) ? 'zh' : 'en',
        source: fileName || '',
        mode: 'image',
        pageCount: pageCount,
        passages: [],
        questions: questions,
        totalMarks: 0,
        warnings: warnings,
        stats: {
          blocks: 0, paras: 0, questions: questions.length, passages: 0,
          hasTeacher: false, mcq: 0, table: 0,
          pdfMode: 'image', pages: pageCount
        }
      };
    });
  }

  RQ.pdf = Pdf;
})();
