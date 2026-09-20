/* 生詞本 ＋ 默寫範圍測試
 *
 * 驗證兩件事：
 *   A. 【bug 修復】在文章內移除生詞後，Backend.myVocab 不再回傳該詞
 *      —— 這是「學生主頁生詞本還顯示已刪掉的詞」的根因。
 *   B. 【新功能】默寫範圍：批次加入、批次刪除、刪除後生詞本從未學會移入已學會、
 *      只動默寫範圍不動生詞本原始資料、學生端唯讀、重畫後狀態一致。
 *
 * 全程用假 fetch + 記憶體 store，**完全不碰真資料**。
 * 用法：node tools/_run_vocab_dict.js
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>vocab/dictation test</title>
<link rel="stylesheet" href="/assets/css/app.css"></head><body>
<div id="view"></div><div id="toast-root"></div><div id="modal-root"></div>
<script>
window.__ERR=[];window.__CALLS=[];
window.onerror=function(m){window.__ERR.push(String(m));};
window.addEventListener('unhandledrejection',function(e){window.__ERR.push('rej:'+e.reason);});
/* 完全離線：任何網路呼叫都回空，不可能寫到老師真資料 */
window.fetch=function(url,opt){
  url=String(url);window.__CALLS.push({url:url,method:(opt&&opt.method)||'GET'});
  return Promise.resolve({ok:true,status:200,
    json:function(){return Promise.resolve({});},
    text:function(){return Promise.resolve('');}});
};
<\/script>
<script src="/assets/js/vendor/jszip.min.js"><\/script>
<script src="/assets/js/core/util.js"><\/script>
<script src="/assets/js/core/crypto.js"><\/script>
<script src="/assets/js/core/store.js"><\/script>
<script src="/assets/js/core/backend.js"><\/script>
<script src="/assets/js/core/docx-parser.js"><\/script>
<script src="/assets/js/core/pdf-parser.js"><\/script>
<script src="/assets/js/ui/highlighter.js"><\/script>
<script src="/assets/js/teacher.js"><\/script>
<script src="/assets/js/student.js"><\/script>
<script>
(async function(){
  var out=[];function ok(n,c,extra){out.push([n,!!c,extra||'']);}
  var RQ=window.RQ, U=RQ.util, B=RQ.backend;
  function finish(){
    var d=document.createElement('pre');d.id='RESULTS';
    d.textContent=out.map(function(x){return (x[1]?'PASS  ':'FAIL  ')+x[0]+(x[2]?'  ['+x[2]+']':'');}).join('\\n')
      +'\\nSUMMARY: '+out.filter(function(x){return x[1];}).length+' pass / '+out.filter(function(x){return !x[1];}).length+' fail'
      +'\\nERRS:'+(window.__ERR.join(' | ')||'none');
    document.body.appendChild(d);
  }
  function wait(ms){return new Promise(function(r){setTimeout(r,ms||60);});}

  try{
    var SID='stu_test';
    /* 老師身分（才看得到操作 UI）；雲端關掉 → 只走本機，測試純粹且可重現 */
    RQ.settings.set({
      session:{role:'teacher',id:SID,name:'測試老師',username:'t'},
      fb:{dbUrl:'',apiKey:'',classCode:'default'},
      gh:{owner:'',repo:'',branch:'main',token:''},
      hook:{url:'',key:''}
    });
    /* IndexedDB 在 headless 第一次開較慢；先暖機，逾時則自動退回記憶體
       （store.js 本身有 3 秒逾時降級，測試照樣可跑，只是不做跨重整持久化） */
    try { await RQ.store.ready(); } catch (e) { }
    try { await B.getRoster(); } catch (e) { }
    await wait(400);

    /* ---------- 準備：造一份含生詞的草稿 ---------- */
    var PASS={id:'p1',title:'測試文章',paragraphs:['今天的天气很好，我们一起去公园散步。']};
    var QUIZ={id:'q_vocab_1',title:'生詞測試卷',published:true,passages:[PASS],
      questions:[],totalMarks:0,createdAt:new Date().toISOString()};
    await RQ.store.quiz.save(QUIZ);

    var draft={id:'draft::q_vocab_1::'+SID,type:'draft',quizId:QUIZ.id,studentId:SID,
      studentName:'測試老師',answers:{},marks:[],vocab:[],notes:[],
      savedAt:new Date().toISOString()};
    await RQ.store.kv.set('draft:'+QUIZ.id+':'+SID, draft);

    /* ---------- A. bug 修復：移除生詞後 myVocab 不該再回傳 ---------- */
    var hl=new RQ.Highlighter({container:document.createElement('div'),passage:PASS,
      marks:[],vocab:[],onChange:function(){}});

    /* 直接驅動加入生詞（模擬選取「天气」並加入生詞本） */
    hl._pending=[{pid:PASS.id,pidx:0,start:2,end:4,text:'天气'}];
    hl._addVocab.apply(hl);
    await wait(60);
    /* _addVocab 開對話框 → 填值後按「加入」 */
    var modal=document.querySelector('.modal');
    ok('加入生詞對話框有開出', !!modal);
    if(modal){
      var inp=modal.querySelector('input');
      if(inp){inp.value='天气';}
      var btns=[].slice.call(modal.querySelectorAll('button'));
      var addBtn=btns.filter(function(b){return /加入/.test(b.textContent)&&!/生詞/.test(b.textContent);})[0];
      ok('對話框有「加入」鈕', !!addBtn);
      if(addBtn){addBtn.click();await wait(140);}
    }
    ok('生詞已進入 highlighter.vocab', (hl.vocab||[]).length===1,
      JSON.stringify((hl.vocab||[]).map(function(v){return v.word;})));
    ok('生詞在文章中留下標示（vocab:true）', (hl.marks||[]).some(function(m){return m.vocab;}));

    /* 把 highlighter 的結果寫回草稿（等同作答頁 onChange → autosave 的行為） */
    draft.marks=hl.marks.slice(); draft.vocab=hl.vocab.slice();
    await B.saveDraft(draft);
    await wait(160);
    var got=await B.myVocab(SID);
    ok('myVocab 讀得到剛加入的生詞', got.some(function(v){return v.word==='天气';}),
      JSON.stringify(got.map(function(v){return v.word;})));

    /* === 關鍵：在文章內把這個生詞刪掉（編輯標示 → 刪除標示） === */
    var target=hl.marks.filter(function(m){return m.vocab;})[0];
    hl._removeMarks(function(x){return x.id===target.id;});
    ok('移除後 marks 不含該標示', !hl.marks.some(function(m){return m.id===target.id;}));
    ok('移除後 vocab 同步清空（bug 修復核心）', (hl.vocab||[]).length===0,
      JSON.stringify((hl.vocab||[]).map(function(v){return v.word;})));

    /* 寫回草稿後，myVocab 必須不再回傳該詞 */
    draft.marks=hl.marks.slice(); draft.vocab=hl.vocab.slice();
    await B.saveDraft(draft);
    await wait(160);
    var got2=await B.myVocab(SID);
    ok('★ 移除後 myVocab 不再回傳該生詞（主頁不再顯示）',
      !got2.some(function(v){return v.word==='天气';}),
      JSON.stringify(got2.map(function(v){return v.word;})));

    /* 也測「清除標示」路徑 */
    hl._pending=[{pid:PASS.id,pidx:0,start:7,end:9,text:'一起'}];
    hl._addVocab.apply(hl); await wait(50);
    var m2=document.querySelector('.modal');
    if(m2){var i2=m2.querySelector('input');if(i2)i2.value='一起';
      var b2=[].slice.call(m2.querySelectorAll('button')).filter(function(b){return /加入/.test(b.textContent)&&!/生詞/.test(b.textContent);})[0];
      if(b2)b2.click(); await wait(140);}
    ok('第二個生詞加入成功', (hl.vocab||[]).length===1,
      JSON.stringify((hl.vocab||[]).map(function(v){return v.word;})));
    hl._pending=[{pid:PASS.id,pidx:0,start:7,end:9,text:'一起'}];
    hl._clearRange.apply(hl);
    ok('★ 用「清除標示」也能同步移除生詞', (hl.vocab||[]).length===0,
      JSON.stringify((hl.vocab||[]).map(function(v){return v.word;})));

    /* ---------- B. 默寫範圍 ---------- */
    /* 重建三個生詞進草稿，供後續操作 */
    var vlist=[{id:'v1',word:'天气',pid:PASS.id,pidx:0,note:'',ts:'2026-01-01T00:00:00Z',learned:false},
               {id:'v2',word:'一起',pid:PASS.id,pidx:0,note:'',ts:'2026-01-02T00:00:00Z',learned:false},
               {id:'v3',word:'公園',pid:PASS.id,pidx:0,note:'',ts:'2026-01-03T00:00:00Z',learned:false}];
    draft.vocab=vlist.slice(); draft.marks=[];
    await RQ.store.kv.set('draft:'+QUIZ.id+':'+SID, draft);
    await wait(120);
    var g3=await B.myVocab(SID);
    ok('生詞本有 3 個詞作為前置', g3.length===3, JSON.stringify(g3.map(function(v){return v.word;})));

    /* 預設：全部都是「未學會」 */
    ok('剛加入的生詞預設為未學會', g3.every(function(v){return !v.learned;}));

    /* 批次加入默寫範圍 */
    var d0=await B.getDictation(SID);
    ok('一開始默寫範圍是空的', (d0.items||[]).length===0);
    var d1=await B.addToDictation(SID,[{word:'天气',source:'生詞本'},{word:'一起',source:'生詞本'}]);
    ok('批次加入 2 個詞', (d1.items||[]).length===2,
      JSON.stringify((d1.items||[]).map(function(x){return x.word;})));
    ok('加入的詞預設未完成', (d1.items||[]).every(function(x){return !x.done;}));

    /* 重複加入不應該變成 4 筆 */
    var d2=await B.addToDictation(SID,[{word:'天气',source:'生詞本'}]);
    ok('重複加入不會產生重複項目', (d2.items||[]).length===2,
      JSON.stringify((d2.items||[]).map(function(x){return x.word;})));

    /* 「公園」也加進去 */
    var d3=await B.addToDictation(SID,[{word:'公園',source:'生詞本'}]);
    ok('再加入第三個詞', (d3.items||[]).length===3);

    /* 重讀（模擬重新整理）→ 必須一致 */
    var d4=await B.getDictation(SID);
    ok('★ 重新讀取默寫範圍結果一致', (d4.items||[]).length===3,
      JSON.stringify((d4.items||[]).map(function(x){return x.word;})));

    /* 完成默寫：移除「天气」與「一起」 */
    var before=await B.myVocab(SID);
    ok('移除前生詞本仍有 3 個詞', before.length===3);

    var rem=await B.removeFromDictation(SID,['天气','一起']);
    ok('批次移除後默寫範圍剩 1 個詞', (rem.items||[]).length===1,
      JSON.stringify((rem.items||[]).map(function(x){return x.word;})));
    ok('回報被移除的詞有 2 個', (rem.removed||[]).length===2);
    ok('★ 只動默寫範圍：生詞本原始資料沒被刪',
      (await B.myVocab(SID)).length===3, '生詞本應仍是 3 個');

    /* 標記已學會 → 生詞本從未學會移入已學會 */
    await B.setVocabLearned(SID,['天气','一起'],true);
    await wait(150);
    var after=await B.myVocab(SID);
    var le=after.filter(function(v){return v.learned;}).map(function(v){return v.word;}).sort();
    var un=after.filter(function(v){return !v.learned;}).map(function(v){return v.word;});
    ok('★ 完成默寫的詞標記為已學會', le.length===2 && le.indexOf('天气')>=0 && le.indexOf('一起')>=0,
      JSON.stringify(le));
    ok('★ 未完成默寫的詞仍在未學會', un.length===1 && un[0]==='公園', JSON.stringify(un));
    ok('生詞本總數不變（只是換分類）', after.length===3);

    /* 重讀仍然一致（模擬重新整理／換裝置） */
    var d5=await B.getDictation(SID);
    ok('★ 刪除後重讀默寫範圍仍是 1 個詞', (d5.items||[]).length===1,
      JSON.stringify((d5.items||[]).map(function(x){return x.word;})));
    var after2=await B.myVocab(SID);
    ok('★ 重讀生詞本的學會狀態仍正確',
      after2.filter(function(v){return v.learned;}).length===2);

    /* ---------- B2. UI：老師看得到操作鈕、學生看不到 ---------- */
    var view=document.getElementById('view');
    await RQ.student.home(view);
    await wait(420);
    var vtext=view.textContent||'';
    ok('學生主頁有「生詞本」標題', /生詞本/.test(vtext));
    ok('學生主頁有「默寫範圍」板塊', /默寫範圍/.test(vtext));
    ok('生詞本分成「未學會」', /未學會/.test(vtext));
    ok('生詞本分成「已學會」', /已學會/.test(vtext));
    var tcheck=view.querySelectorAll('.vb-board input[type=checkbox]').length;
    ok('★ 老師身分看得到勾選框', tcheck>0, 'checkbox 數='+tcheck);
    var tbtns=[].slice.call(view.querySelectorAll('.vb-board button')).map(function(b){return (b.textContent||'').trim();});
    ok('老師看得到「加入默寫範圍」鈕', tbtns.some(function(t){return /加入默寫範圍/.test(t);}),
      JSON.stringify(tbtns));
    ok('老師看得到「完成默寫」鈕', tbtns.some(function(t){return /完成默寫/.test(t);}),
      JSON.stringify(tbtns));
    /* 注意：這裡在樣板字串內，regex 內不可出現 '\/'（會被展開成 '/'，
       導致 regex 提前結束 → Invalid regular expression flags，整支 script 掛掉）。
       一律用 new RegExp + String.fromCharCode(47) 組出斜線。 */
    var SLASH=String.fromCharCode(47);
    ok('老師看得到「全選／取消全選」',
      new RegExp('全選['+SLASH+'／]取消全選').test(vtext));
    ok('畫面有並排看板容器 .vb-board', !!view.querySelector('.vb-board'));

    /* 切成學生身分 → 唯讀 */
    RQ.settings.set({session:{role:'student',id:SID,name:'測試同學',username:'s'}});
    var view2=document.getElementById('view');
    await RQ.student.home(view2);
    await wait(420);
    var ctext=view2.textContent||'';
    var ccheck=view2.querySelectorAll('.vb-board input[type=checkbox]').length;
    ok('★ 學生身分看不到任何勾選框（唯讀）', ccheck===0, 'checkbox 數='+ccheck);
    /* 學生端：用「實際按鈕」判斷，不要用文字包含判斷
       —— 唯讀提示文案本身就有「完成默寫後…」字樣，會造成假失敗 */
    var cbtns = [].slice.call(view2.querySelectorAll('.vb-board button')).map(function (b) {
      return (b.textContent || '').trim();
    });
    ok('★ 學生看不到操作按鈕（唯讀）', cbtns.length === 0, '按鈕=' + JSON.stringify(cbtns));
    ok('學生看不到「加入默寫範圍」鈕',
      !cbtns.some(function (t) { return /加入默寫範圍/.test(t); }));
    ok('學生看不到「完成默寫」鈕',
      !cbtns.some(function (t) { return /完成默寫/.test(t); }));
    ok('學生仍看得到生詞內容', /天气|一起|公園/.test(ctext));
    ok('學生仍看得到默寫範圍清單', /默寫範圍/.test(ctext));
    ok('學生看得到唯讀說明', /老師維護/.test(ctext));

    finish();
  }catch(e){
    out.push(['EXCEPTION',false,(e&&e.stack)||String(e)]);
    finish();
  }
})();
<\/script>
</body></html>`;

let pagePath = '';
const PORT_FILE = path.join(os.tmpdir(), 'rq_vd_port.txt');

server.listen(0, '127.0.0.1', function () {
  const port = server.address().port;
  pagePath = path.join(ROOT, 'tools', '_vocab_dict.html');
  fs.writeFileSync(pagePath, PAGE, 'utf8');

  const url = 'http://127.0.0.1:' + port + '/tools/_vocab_dict.html';
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'rq-vd-' + Date.now()),
    '--virtual-time-budget=90000', '--dump-dom', url]);

  let out = '';
  let errout = '';
  ch.stdout.on('data', d => out += d);
  ch.stderr.on('data', d => { errout += d; });
  ch.on('close', () => {
    try { fs.unlinkSync(pagePath); } catch (e) { }
    const m = out.match(/<pre id="RESULTS">([\s\S]*?)<\/pre>/);
    if (!m) {
      console.log('❌ 沒有取到測試結果（頁面可能載入失敗）');
      /* 保留原始 dump 以便事後追查，不要只印一行「沒有結果」 */
      try {
        const dump = path.join(ROOT, 'tools', '_vd_dump.txt');
        fs.writeFileSync(dump, out, 'utf8');
        console.log('原始 dump 已寫入 tools/_vd_dump.txt（bytes=' + out.length + '）');
      } catch (e) { }
      console.log('dump 有 <body>:', out.indexOf('<body') >= 0,
        '| 有 id="RESULTS":', out.indexOf('id="RESULTS"') >= 0);
      const bi = out.indexOf('<body');
      if (bi >= 0) console.log('body 內容片段:', out.slice(bi, bi + 400).replace(/\s+/g, ' '));
      console.log('--- stderr ---');
      console.log((errout.split('\n').filter(l => /error|Error|fail|refus/i.test(l)).slice(0, 10).join('\n')) || '(無)');
      server.close(); process.exit(1);
    }
    const txt = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    console.log(txt);
    const fails = (txt.match(/^FAIL/gm) || []).length;
    server.close();
    process.exit(fails ? 1 : 0);
  });
});

setTimeout(() => { console.log('❌ 總逾時'); try { server.close(); } catch (e) { } process.exit(1); }, 180000);
