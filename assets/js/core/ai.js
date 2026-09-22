/* ============================================================
   ai.js — 把「已經解析好的試卷」交給大語言模型（LLM）做額外分析

   為什麼需要它：解析器是用規則寫死的，遇到排版特殊的試卷一定有盲點
   （抓不到題號、答案對不上、表格串味…）。有了 AI 這一層，老師可以直接
   請模型「檢查哪幾題沒抓到答案」「把第 7 題的表格補齊」「產生解析」。

   ------------------------------------------------------------
   三個通道（依序嘗試，全部都在瀏覽器端，不需要後端伺服器）
     A. hook   走既有的 Apps Script／Webhook 代理（金鑰留在伺服器端，最安全）
     B. direct 老師自己填 API 金鑰，直接打 OpenAI 相容端點（最簡單）
     C. gemini Google Gemini（金鑰放 query string，CORS 友善）
   ------------------------------------------------------------
   設定（localStorage `rq.settings.v1` 的 `ai` 欄位）：
     {
       enabled:  true,
       provider: 'direct' | 'gemini' | 'hook',
       endpoint: 'https://api.openai.com/v1'   // OpenAI 相容 base
       model:    'gpt-4o-mini',
       apiKey:   'sk-…',
       keyQuery: 'key',                        // gemini 用
       viaHook:  false                         // 連 hook 也一起試
     }

   🔒 隱私：提供者是 Google／OpenAI 時，試卷文字會離開你的裝置。
      若在意隱私，請改用 'hook' 並把金鑰放在 Apps Script 的指令碼屬性裡。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util;

  var PROVIDERS = {
    direct: {
      label: 'OpenAI 相容端點（OpenAI／DeepSeek／Groq／Ollama…）',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini'
    },
    gemini: {
      label: 'Google Gemini（免費金鑰即可，不必付費）',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      /* ⚠ Google 會定期淘汰舊模型：gemini-2.0-flash 的免費端點已在 2026-06-01 關閉。
         這裡只放「找不到可用模型時」的後備值；實際送出前會先問一次 ListModels，
         自動挑最新可用的 flash（見 pickGeminiModel）。 */
      model: 'gemini-2.5-flash'
    },
    hook: {
      label: '自架代理（Apps Script／Cloudflare Worker，金鑰不外流）',
      endpoint: '',
      model: ''
    }
  };

  /* Gemini 免費層的模型偏好順序（由新到舊）。
     為什麼不寫死一個：Google 幾乎每季就淘汰舊模型，寫死會在某天突然 404。 */
  var GEMINI_PREFERENCE = [
    'gemini-flash-latest',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash'
  ];

  var DEFAULT_AI = {
    enabled: false,
    provider: 'direct',
    endpoint: '',
    model: '',
    apiKey: '',
    keyQuery: 'key',
    viaHook: false,
    temperature: 0.2,
    maxChars: 30000
  };

  /* ---------- 任務定義 ---------- */
  var TASKS = {
    review: {
      label: '體檢（找出解析漏掉的題目／答案）',
      system: '你是一位熟悉香港小學與中學閱讀理解試卷的資深中文科老師，擅長校對試卷的結構化資料。',
      build: function (ctx) {
        return [
          '以下是一份已被程式自動解析成 JSON 的閱讀理解試卷。請幫我做「體檢」，找出解析錯誤或漏掉的地方。',
          '',
          '【試卷 JSON】',
          ctx.json,
          '',
          '請以繁體中文輸出，格式如下（不要加多餘前言）：',
          '## 整體判斷',
          '（一句話說明這份解析的可靠程度）',
          '',
          '## 有問題的題目',
          '逐題列出，每項格式：`第 N 題｜問題類型｜建議修正`',
          '問題類型請用這幾種：漏答案／答案錯誤／選項不全／表格串味／文章闕漏／題幹被吞／其他',
          '若某題沒問題就不要列出來。',
          '',
          '## 補齊用的 JSON 片段',
          '針對「漏答案」的題目，輸出一段可以直接貼回試卷的 JSON Patch 陣列，格式：',
          '[{"no": 7, "answer": "B"}, {"no": 9, "answer": "承先啟後，帶出下文…"}]',
          '若無需補齊，輸出 `[]`。'
        ].join('\n');
      }
    },

    answers: {
      label: '補上缺少的答案',
      system: '你是香港中文科閱讀理解試卷的閱卷老師，能依文章內容推斷標準答案。',
      build: function (ctx) {
        return [
          '以下是一份閱讀理解試卷（已解析成 JSON）。有些題目沒有答案。',
          '請依文章內容（passages）推斷最合理的答案。',
          '',
          '【試卷 JSON】',
          ctx.json,
          '',
          '只輸出 JSON 陣列，不要任何說明文字。格式：',
          '[{"no": 3, "answer": "B", "explanation": "因為……」}, {"no": 9, "answer": "……"}]',
          '選擇題的 answer 只放單一字母；文字題放完整答案。',
          '不確定的題目請不要輸出（寧缺勿濫）。'
        ].join('\n');
      }
    },

    explain: {
      label: '產生／補強答案解析',
      system: '你是香港中文科閱讀理解試卷的資深老師，解析要具體引用原文，不要空泛。',
      build: function (ctx) {
        return [
          '以下是一份閱讀理解試卷（已解析成 JSON）。請為每一題產生「答案解析」。',
          '解析要求：先指出答案對應的原文位置，再說明理由，最後點出常見錯誤。每題 40–120 字。',
          '',
          '【試卷 JSON】',
          ctx.json,
          '',
          '只輸出 JSON 陣列，不要任何說明文字。格式：',
          '[{"no": 1, "explanation": "……"}]'
        ].join('\n');
      }
    },

    structure: {
      label: '重排結構（修正文章／題目／分卷歸屬）',
      system: '你是試卷資料工程師，擅長把混亂的文字還原成結構化試卷。',
      build: function (ctx) {
        return [
          '以下是一份閱讀理解試卷的文字（可能是 OCR 或老師手打的），以及程式目前解析出的結構。',
          '請判斷程式哪裡切錯了，並提出修正建議。',
          '',
          '【原始文字】',
          ctx.rawText || '(未提供)',
          '',
          '【目前解析結果 JSON】',
          ctx.json,
          '',
          '請以繁體中文輸出：',
          '## 切錯的地方',
          '## 建議的文字標記方式',
          '（例如「第 6 題的表格請在題目行後緊接 Markdown 表格」、「第 12 題前請補上 `## 第二篇`」）'
        ].join('\n');
      }
    },

    free: {
      label: '自由提問',
      system: '你是熟悉香港小學與中學閱讀理解試卷的資深老師。',
      build: function (ctx) {
        return [
          '以下是一份閱讀理解試卷（已解析成 JSON）：',
          '',
          ctx.json,
          '',
          '【老師的要求】',
          ctx.question || '請說明這份試卷的難度與考核重點。'
        ].join('\n');
      }
    }
  };

  /* ---------- 設定 ---------- */
  function cfg() {
    var s = (RQ.settings && RQ.settings.get && RQ.settings.get()) || {};
    var a = s.ai || {};
    var out = {};
    Object.keys(DEFAULT_AI).forEach(function (k) {
      out[k] = (a[k] === undefined || a[k] === null || a[k] === '') ? DEFAULT_AI[k] : a[k];
    });
    return out;
  }

  function save(patch) {
    return RQ.settings.set({ ai: patch });
  }

  /** 目前哪個通道「看起來」可用 */
  function route() {
    var c = cfg();
    var s = (RQ.settings && RQ.settings.get && RQ.settings.get()) || {};
    var hookUrl = (s.hook && s.hook.postUrl) || '';
    if (c.provider === 'hook') return hookUrl ? { kind: 'hook', ready: true } : { kind: 'hook', ready: false, why: '尚未設定 hook.postUrl' };
    if (c.provider === 'gemini') return c.apiKey ? { kind: 'gemini', ready: true } : { kind: 'gemini', ready: false, why: '尚未填 Gemini API 金鑰' };
    if (c.provider === 'direct') return c.apiKey ? { kind: 'direct', ready: true } : { kind: 'direct', ready: false, why: '尚未填 API 金鑰' };
    return { kind: c.provider, ready: false, why: '未知的提供者' };
  }

  function isReady() { return cfg().enabled && route().ready; }

  /* ---------- 打包試卷成精簡 JSON（省 token） ---------- */
  function packQuiz(quiz, opt) {
    opt = opt || {};
    var maxQ = opt.maxQuestions || 60;
    var obj = {
      title: quiz.title || '',
      level: quiz.level || '',
      subject: quiz.subject || '',
      totalMarks: quiz.totalMarks || 0,
      passages: (quiz.passages || []).map(function (p, i) {
        var txt = (p.paragraphs || []).join('\n');
        if (txt.length > 6000) txt = txt.slice(0, 6000) + '…（略）';
        return { index: i + 1, title: p.title || ('第 ' + (i + 1) + ' 篇'), text: txt };
      }),
      questions: (quiz.questions || []).slice(0, maxQ).map(function (q) {
        var o = {
          no: q.no,
          stem: (q.stem || '').slice(0, 400),
          marks: q.marks || 0,
          type: q.type || 'text'
        };
        if (q.section) o.section = q.section;
        if (q.passageId) o.passageId = q.passageId;
        if (q.options && q.options.length) {
          o.options = q.options.map(function (x) { return { key: x.key, text: String(x.text || '').slice(0, 200) }; });
        }
        if (q.table && q.table.rows) {
          o.table = q.table.rows.slice(0, 24).map(function (r) {
            return (r || []).map(function (c) { return String((c && (c.visible || c.text)) || '').slice(0, 120); });
          });
        }
        if (q.subQuestions && q.subQuestions.length) {
          o.subQuestions = q.subQuestions.slice(0, 30).map(function (s) {
            return { label: s.label || '', prompt: String(s.prompt || '').slice(0, 200), answer: String(s.answer || '').slice(0, 300) };
          });
        }
        if (q.answer) o.answer = String(q.answer).slice(0, 600);
        if (q.answerKeys && q.answerKeys.length) o.answerKeys = q.answerKeys;
        if (q.explanation) o.explanation = String(q.explanation).slice(0, 500);
        if (q.quotes && q.quotes.length) o.quotes = q.quotes.slice(0, 6).map(function (t) { return String(t).slice(0, 200); });
        if (q.skip) o.skip = true;
        return o;
      })
    };
    return obj;
  }

  function packText(quiz) {
    var max = cfg().maxChars;
    var s = JSON.stringify(packQuiz(quiz), null, 1);
    if (s.length <= max) return s;
    /* 太長 → 只留題目（文章砍掉） */
    var slim = { title: quiz.title, questions: packQuiz(quiz, { maxQuestions: 80 }).questions };
    s = JSON.stringify(slim, null, 1);
    if (s.length > max) s = s.slice(0, max) + '\n…（內容過長已截斷）';
    return s;
  }

  /* ---------- 通道：OpenAI 相容 ---------- */
  function callDirect(c, messages) {
    var base = String(c.endpoint || '').replace(/\/+$/, '');
    if (!base) throw new Error('尚未設定 API 端點（endpoint）');
    var url = base + (/(\/v1|\/openai)$/.test(base) || /\/v\d/.test(base) ? '/chat/completions' : '/v1/chat/completions');
    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.apiKey
      },
      body: JSON.stringify({
        model: c.model || PROVIDERS.direct.model,
        temperature: c.temperature,
        messages: messages
      })
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
        if (!r.ok) {
          var msg = (j && j.error && (j.error.message || j.error)) || t.slice(0, 300) || ('HTTP ' + r.status);
          throw new Error('AI 服務回應錯誤（' + r.status + '）：' + msg);
        }
        if (!j) throw new Error('AI 回應不是 JSON：' + t.slice(0, 200));
        var ch = j.choices && j.choices[0];
        var txt = ch && ((ch.message && ch.message.content) || ch.text);
        if (!txt) throw new Error('AI 回應沒有內容');
        return { text: txt, model: j.model || c.model, usage: j.usage || null };
      });
    });
  }

  /* ---------- 通道：Gemini ---------- */

  /* 快取「這把金鑰可用的模型清單」，避免每次都多打一趟 ListModels */
  var _gemCache = {};   /* { '<金鑰前 8 碼>@<base>': [modelId, …] } */

  /** 清掉模型清單快取（測試用；換金鑰時也順手清） */
  function clearModelCache() { _gemCache = {}; return true; }

  /** 問 Google 這把金鑰現在能用哪些 generateContent 模型 */
  function listGeminiModels(c) {
    var base = String(c.endpoint || PROVIDERS.gemini.endpoint).replace(/\/+$/, '');
    var cacheKey = String(c.apiKey || '').slice(0, 8) + '@' + base;
    if (_gemCache[cacheKey]) return Promise.resolve(_gemCache[cacheKey]);
    var url = base + '/models?' + (c.keyQuery || 'key') + '=' + encodeURIComponent(c.apiKey) + '&pageSize=200';
    return fetch(url, { method: 'GET', cache: 'no-store' }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { }
        if (!r.ok) {
          var msg = (j && j.error && (j.error.message || j.error)) || t.slice(0, 200) || ('HTTP ' + r.status);
          throw new Error('無法讀取 Gemini 模型清單（' + r.status + '）：' + msg);
        }
        var ids = (j && j.models ? j.models : [])
          .filter(function (m) {
            return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
          })
          .map(function (m) { return String(m.name || '').replace(/^models\//, ''); });
        _gemCache[cacheKey] = ids;
        return ids;
      });
    });
  }

  /**
   * 挑一個可用的 Gemini 模型。
   * 需求：Google 會淘汰舊模型（gemini-2.0-flash 免費端點 2026-06-01 已關），
   * 所以「先問清單、再依偏好順序挑」比寫死一個型號耐用得多。
   */
  function pickGeminiModel(c, available) {
    var want = String(c.model || '').trim();
    /* 老師自己填的型號：在清單裡就直接用（尊重選擇） */
    if (want && available.indexOf(want) >= 0) return want;
    /* 偏好順序中第一個存在的 */
    for (var i = 0; i < GEMINI_PREFERENCE.length; i++) {
      if (available.indexOf(GEMINI_PREFERENCE[i]) >= 0) return GEMINI_PREFERENCE[i];
    }
    /* 都沒有 → 退而求其次：任何名稱含 flash 的（便宜、免費層可用） */
    var flash = available.filter(function (m) { return /flash/i.test(m) && !/thinking|image|tts|native-audio/i.test(m); });
    if (flash.length) return flash[0];
    if (available.length) return available[0];
    /* 清單空 → 用老師填的或後備值，讓真正的錯誤訊息露出來 */
    return want || PROVIDERS.gemini.model;
  }

  function callGemini(c, messages) {
    var base = String(c.endpoint || PROVIDERS.gemini.endpoint).replace(/\/+$/, '');
    var sys = messages.filter(function (m) { return m.role === 'system'; })
      .map(function (m) { return m.content; }).join('\n');
    var contents = messages.filter(function (m) { return m.role !== 'system'; })
      .map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; });
    var body = {
      contents: contents,
      generationConfig: { temperature: c.temperature, maxOutputTokens: 8192 }
    };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };

    function send(model) {
      var url = base + '/models/' + encodeURIComponent(model) +
        ':generateContent?' + (c.keyQuery || 'key') + '=' + encodeURIComponent(c.apiKey);
      return fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = JSON.parse(t); } catch (e) { }
          if (!r.ok) {
            var msg = (j && j.error && (j.error.message || j.error)) || t.slice(0, 300) || ('HTTP ' + r.status);
            var err = new Error('Gemini 回應錯誤（' + r.status + '）：' + msg);
            err.status = r.status;
            /* 把 Google 的機器可讀原因帶出來（NOT_FOUND / RESOURCE_EXHAUSTED…） */
            err.reason = (j && j.error && j.error.status) || '';
            throw err;
          }
          var cand = j && j.candidates && j.candidates[0];
          var txt = cand && cand.content && cand.content.parts &&
            cand.content.parts.map(function (p) { return p.text || ''; }).join('');
          if (!txt) {
            throw new Error('Gemini 回應沒有內容' +
              (cand && cand.finishReason ? '（finishReason=' + cand.finishReason + '）' : '') +
              (j && j.promptFeedback ? '（' + JSON.stringify(j.promptFeedback).slice(0, 160) + '）' : ''));
          }
          return { text: txt, model: model, usage: j.usageMetadata || null };
        });
      });
    }

    /* ① 先問清單、挑一個能用的型號（清單讀不到就退回老師填的值，照樣送出） */
    var asked = String(c.model || '').trim();
    return listGeminiModels(c).catch(function () { return null; }).then(function (available) {
      var model = available ? pickGeminiModel(c, available) : (asked || PROVIDERS.gemini.model);
      return send(model).catch(function (e) {
        /* ② 若老師填的型號已下架（404 NOT_FOUND），自動改用清單裡最新的再試一次。
              這是「Google 淘汰模型」最常見的症狀，使用者不該為此自己去改設定。 */
        var isGone = e.status === 404 ||
          /not found|not supported|no longer available|does not exist/i.test(String(e.message || ''));
        if (!isGone || !available || !available.length) throw e;
        var alt = pickGeminiModel({ model: '' }, available);      /* 強制重新挑 */
        if (!alt || alt === model) throw e;
        return send(alt).then(function (out) {
          out.model = alt;
          out.autoSwitchedFrom = model;
          return out;
        });
      });
    });
  }

  /* ---------- 通道：hook 代理（Apps Script／Worker） ---------- */
  function callHook(c, messages) {
    var s = (RQ.settings && RQ.settings.get && RQ.settings.get()) || {};
    var url = (s.hook && s.hook.postUrl) || '';
    if (!url) throw new Error('尚未設定 hook.postUrl');
    var key = (s.hook && s.hook.key) || '';
    var payload = {
      action: 'ai',
      key: key,
      provider: c.provider === 'hook' ? (c.upstream || 'direct') : c.provider,
      endpoint: c.endpoint || '',
      model: c.model || '',
      temperature: c.temperature,
      messages: messages
    };
    if (c.provider !== 'hook') payload.apiKey = c.apiKey;   /* 讓代理代打，金鑰仍會經過網路 */

    return fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },  /* Apps Script 對 JSON 會做 preflight */
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { }
        if (!r.ok) throw new Error('代理回應錯誤（' + r.status + '）：' + (t.slice(0, 200) || ''));
        if (!j) throw new Error('代理回應不是 JSON：' + t.slice(0, 200));
        if (j.error) throw new Error('代理回報錯誤：' + (typeof j.error === 'string' ? j.error : JSON.stringify(j.error).slice(0, 200)));
        var txt = j.text || (j.content) || '';
        if (!txt) throw new Error('代理沒有回傳文字內容');
        return { text: txt, model: j.model || c.model, usage: j.usage || null };
      });
    });
  }

  function callOnce(kind, c, messages) {
    if (kind === 'gemini') return callGemini(c, messages);
    if (kind === 'hook') return callHook(c, messages);
    return callDirect(c, messages);
  }

  /**
   * 送出對話（自動依 provider 選通道；provider 失敗時可退回 hook）
   * @param {Array} messages [{role:'system'|'user'|'assistant', content}]
   * @param {Object} opt {noFallback:true}
   */
  function chat(messages, opt) {
    opt = opt || {};
    var c = cfg();
    var r = route();
    if (!c.enabled) return Promise.reject(new Error('AI 功能尚未啟用（請到「設定 → AI 助理」開啟）'));
    if (!r.ready) return Promise.reject(new Error(r.why || 'AI 尚未設定完成'));

    return callOnce(r.kind, c, messages).catch(function (e) {
      /* provider 失敗 → 若設定了 hook 且允許，改走 hook 再試一次 */
      var s = (RQ.settings && RQ.settings.get && RQ.settings.get()) || {};
      var hookUrl = (s.hook && s.hook.postUrl) || '';
      if (!opt.noFallback && r.kind !== 'hook' && hookUrl && c.viaHook) {
        return callHook(c, messages).catch(function (e2) {
          throw new Error((e && e.message ? e.message : e) + ' ／ 改走代理也失敗：' + (e2 && e2.message ? e2.message : e2));
        });
      }
      throw e;
    });
  }

  /**
   * 執行一個預設任務
   * @param {string} task  review | answers | explain | structure | free
   * @param {Object} quiz  試卷物件
   * @param {Object} opt   {question, rawText}
   */
  function run(task, quiz, opt) {
    opt = opt || {};
    var def = TASKS[task] || TASKS.free;
    var ctx = {
      json: packText(quiz),
      question: opt.question || '',
      rawText: (opt.rawText || '').slice(0, cfg().maxChars)
    };
    var messages = [
      { role: 'system', content: def.system },
      { role: 'user', content: def.build(ctx) }
    ];
    return chat(messages).then(function (out) {
      out.task = task;
      out.label = def.label;
      return out;
    });
  }

  /** 從 AI 回覆裡挖出第一個 JSON 陣列（用於「補答案」） */
  function extractJSON(text) {
    var t = String(text || '');
    var f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (f) t = f[1];
    var s = t.indexOf('['), e = t.lastIndexOf(']');
    if (s < 0 || e <= s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
  }

  /**
   * 把 AI 回覆的修補套回試卷（不寫檔，回傳新的 questions）
   * @returns {{questions:Array, applied:number, skipped:number, detail:Array}}
   */
  function applyPatches(quiz, patches) {
    var qs = (quiz.questions || []).map(function (q) { return JSON.parse(JSON.stringify(q)); });
    var applied = 0, skipped = 0, detail = [];
    (patches || []).forEach(function (p) {
      if (!p || p.no == null) { skipped++; return; }
      var q = qs.filter(function (x) { return x.no === p.no; })[0];
      if (!q) { skipped++; detail.push({ no: p.no, why: '找不到這題' }); return; }
      var touched = [];
      if (p.answer !== undefined && p.answer !== null && p.answer !== '') {
        var ans = String(p.answer).trim();
        var mk = ans.match(/^([A-H])(?:[\s.、)）]|$)/);
        if (mk && (q.type === 'mcq' || (q.options && q.options.length))) {
          q.answerKeys = [mk[1]];
          q.answer = mk[1];
        } else {
          q.answer = ans;
        }
        touched.push('answer');
      }
      if (p.explanation) { q.explanation = String(p.explanation).trim(); touched.push('explanation'); }
      if (p.stem) { q.stem = String(p.stem).trim(); touched.push('stem'); }
      if (p.skip === true) { q.skip = true; q.skipReason = q.skipReason || 'AI 建議略過'; touched.push('skip'); }
      if (!touched.length) { skipped++; return; }
      applied++;
      detail.push({ no: q.no, fields: touched });
    });
    return { questions: qs, applied: applied, skipped: skipped, detail: detail };
  }

  /** hook 代理的健康檢查（老師按「測試連線」用） */
  function ping() {
    var c = cfg();
    return chat([
      { role: 'system', content: '你是測試用的助理，只回覆指定內容。' },
      { role: 'user', content: '請只回覆兩個字：成功' }
    ], { noFallback: true }).then(function (out) {
      return {
        ok: true, text: U.trim(out.text).slice(0, 40), model: out.model,
        provider: c.provider, switchedFrom: out.autoSwitchedFrom || ''
      };
    });
  }

  /**
   * 列出「這把金鑰現在真的能用的 Gemini 模型」。
   * 給設定頁的「看看有哪些模型」用——Google 淘汰模型時老師能自己確認，
   * 不必回來問開發者。
   */
  function listModels(override) {
    var c = Object.assign({}, cfg(), override || {});
    if (!c.apiKey) return Promise.reject(new Error('請先填 API 金鑰'));
    return listGeminiModels(c).then(function (ids) {
      /* 好用的排前面（flash 系列），其餘照原順序 */
      var usable = ids.filter(function (m) { return !/embedding|aqa|imagen|veo|tts|native-audio/i.test(m); });
      var flash = usable.filter(function (m) { return /flash/i.test(m); });
      var rest = usable.filter(function (m) { return flash.indexOf(m) < 0; });
      return { all: usable, preferred: flash.concat(rest), suggested: pickGeminiModel(c, usable) };
    });
  }

  RQ.ai = {
    PROVIDERS: PROVIDERS,
    TASKS: TASKS,
    DEFAULT: DEFAULT_AI,
    cfg: cfg,
    save: save,
    route: route,
    isReady: isReady,
    chat: chat,
    run: run,
    ping: ping,
    listModels: listModels,
    clearModelCache: clearModelCache,
    packQuiz: packQuiz,
    packText: packText,
    extractJSON: extractJSON,
    applyPatches: applyPatches
  };
})(window.RQ);
