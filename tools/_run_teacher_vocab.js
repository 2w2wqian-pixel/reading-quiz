/* 老師端「③ 生詞與默寫」＋ 首頁／路由防護測試
 *
 * 驗證三件事：
 *   A. 【新功能】老師端有「③ 生詞與默寫」分頁，可切換學生、看到該生的
 *      生詞本與默寫範圍，並且操作鈕是「可寫」的（老師代學生維護）。
 *   B. 【重要】首頁不再對未登入訪客／學生列出所有已發佈試卷。
 *      學生只能看到「指派的作業」入口，未登入只看得到登入入口。
 *   C. 【重要】直接打 #/quiz/<id> 也不能繞過指派（猜 id 攻擊）。
 *      assignOnly=true 時未指派 → 擋下；assignOnly=false 時開放。
 *
 * 全程用假 fetch + 記憶體 store，**完全不碰真資料**。
 * 用法：node tools/_run_teacher_vocab.js
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

/* 注意：整頁是 JS 樣板字串。regex 內不可出現反斜線＋斜線（會被展開成 '/'，
   導致 regex 提前結束 → 整支 script 不解析 → 永遠拿不到 RESULTS）。
   一律用 new RegExp + String.fromCharCode(47) 組斜線。 */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>teacher vocab test</title>
<link rel="stylesheet" href="/assets/css/app.css"></head><body>
<header id="topbar"><div id="who"></div></header>
<div id="view"></div><div id="toast-root"></div><div id="modal-root"></div>
<script>
window.__ERR=[];window.__CALLS=[];
window.onerror=function(m){window.__ERR.push(String(m));};
window.addEventListener('unhandledrejection',function(e){window.__ERR.push('rej:'+e.reason);});
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
<script src="/assets/js/app.js"><\/script>
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
  function txt(el){return (el&&el.textContent)||'';}
  function btns(el){
    return [].slice.call((el||document).querySelectorAll('button'))
      .map(function(b){return (b.textContent||'').trim();});
  }
  /* 下拉選單的選項要用 .options 取（textContent 掃不到 option 文字，會假失敗） */
  function opts(sel){
    return sel ? [].slice.call(sel.options).map(function(o){
      return { value:o.value, text:(o.text||o.textContent||'').trim() };
    }) : [];
  }
  var SLASH=String.fromCharCode(47);
  var CIRCLED='①②③④⑤⑥';

  try{
    var TID='t_main';
    /* app.js 的 boot() 會跑一次 route() 並接管 #view；先讓它跑完再開始，
       否則它會在測試中途把 view 蓋掉。 */
    await new Promise(function(r){ setTimeout(r, 300); });
    try { await RQ.store.ready(); } catch (e) { }
    await wait(400);

    /* 老師身分；雲端全關 → 只走本機，可重現。
       ⚠ 順序很重要：app.js 已載入，boot() 過後才設身分，否則 renderWho() 會是登出狀態。
       另外老師端要求本機 teacherPass，這裡先種一組。 */
    RQ.settings.set({
      session:{role:'teacher',id:TID,name:'測試老師',username:'t'},
      fb:{dbUrl:'',apiKey:'',classCode:'default'},
      gh:{owner:'',repo:'',branch:'main',token:''},
      hook:{url:'',key:''}
    });
    /* 老師端登入閘門讀的是本機 settings.teacherPass（純字串，非雜湊） */
    RQ.settings.set({ teacherPass:'test1234' });
    ok('【前置】老師本機密碼已種入（Teacher.render 不會被登入頁擋下）',
      !!RQ.settings.get().teacherPass);
    await wait(200);

    /* ---------- 準備資料：名冊 + 三份試卷 + 一份草稿 ---------- */
    /* 名冊用 saveStudent（= registerStudent(stu, true)）；沒有 saveRoster 這個 API。
       雲端全關 → 只寫本機，不會污染任何真實資料。 */
    for (const stu of [
      { username:'s1', name:'陳小明', pass:'x', className:'中二A' },
      { username:'s2', name:'李小花', pass:'x', className:'中二B' }
    ]) {
      try { await B.saveStudent(Object.assign({}, stu)); } catch (e) {
        out.push(['（前置）寫入名冊失敗 '+stu.username, false, String((e&&e.message)||e)]);
      }
    }
    var roster=[], found=null;
    try { roster = await B.getRoster(); } catch(e){}
    ok('名冊讀得到 2 位學生', roster.length===2,
      JSON.stringify(roster.map(function(s){return s.name+':'+s.id;})));
    var s1=roster.filter(function(s){return s.username==='s1';})[0];
    var s2=roster.filter(function(s){return s.username==='s2';})[0];
    ok('名冊學生有 id（不是 undefined）', !!(s1&&s1.id) && !!(s2&&s2.id));
    ok('名冊學生的班別讀得回來', !!(s1&&(s1.className==='中二A'||(s1.classes||[]).indexOf('中二A')>=0)),
      s1?JSON.stringify({className:s1.className,classes:s1.classes}):'(無)');
    if(!s1||!s2){ throw new Error('名冊前置失敗，後續測試無意義'); }
    var S1=s1.id, S2=s2.id;

    var PV={id:'pas1',title:'測試課文',paragraphs:['小明每天早上去公園散步，看見很多花。'],lang:'zh'};
    var QUIZ_ASSIGNED={id:'qz_assigned',title:'已指派試卷',published:true,
      passages:[PV],questions:[{no:1,stem:'測試題',type:'mcq',options:['A','B'],answerKeys:['A'],marks:2}],
      totalMarks:2,createdAt:new Date().toISOString(),
      assignment:{all:false,ids:[S1],due:'2026-12-31'}};
    var QUIZ_OTHER={id:'qz_other',title:'別人的試卷',published:true,
      passages:[PV],questions:[],totalMarks:0,createdAt:new Date().toISOString(),
      assignment:{all:false,ids:[S2],due:'2026-12-31'}};
    var QUIZ_TOM={id:'qz_tom',title:'別的班別的試卷',published:true,
      passages:[PV],questions:[],totalMarks:0,createdAt:new Date().toISOString(),
      assignment:{all:false,ids:[],classes:['中二B'],due:'2026-12-31'}};
    var QUIZ_FREE={id:'qz_free',title:'不指派限制的試卷',published:true,
      passages:[PV],questions:[],totalMarks:0,createdAt:new Date().toISOString(),
      assignment:{all:true}};
    try{
      await RQ.store.quiz.save(QUIZ_ASSIGNED);
      await RQ.store.quiz.save(QUIZ_OTHER);
      await RQ.store.quiz.save(QUIZ_TOM);
      await RQ.store.quiz.save(QUIZ_FREE);
    }catch(e){out.push(['（前置）寫入試卷失敗',false,String(e&&e.message||e)]);}

    /* 給 s1 一份生詞草稿 + 默寫範圍 */
    var draft={id:'draft::'+QUIZ_ASSIGNED.id+'::'+S1,type:'draft',
      quizId:QUIZ_ASSIGNED.id,studentId:S1,studentName:'陳小明',
      answers:{},marks:[],notes:[],savedAt:new Date().toISOString(),
      vocab:[{id:'w1',word:'公園',pid:PV.id,pidx:0,note:'公園 park',ts:'2026-02-01T00:00:00Z',learned:false},
             {id:'w2',word:'散步',pid:PV.id,pidx:0,note:'',ts:'2026-02-02T00:00:00Z',learned:false},
             {id:'w3',word:'看見',pid:PV.id,pidx:0,note:'',ts:'2026-02-03T00:00:00Z',learned:true}]};
    try { await RQ.store.kv.set('draft:'+QUIZ_ASSIGNED.id+':'+S1, draft); }catch(e){}
    try { await B.addToDictation(S1,[{word:'公園',source:'生詞本'}]); }catch(e){}
    await wait(200);

    /* ---------- A. 老師端「③ 生詞與默寫」分頁 ---------- */
    var tabs=(RQ.teacher&&RQ.teacher.TABS)||[];
    ok('老師分頁表有「生詞與默寫」', tabs.some(function(t){return /生詞與默寫/.test(t.label||'');}),
      JSON.stringify(tabs.map(function(t){return t.label;})));
    var vocabTab=tabs.filter(function(t){return t.id==='vocab';})[0];
    ok('該分頁 id 為 vocab', !!vocabTab, vocabTab?vocabTab.label:'(無)');
    ok('分頁編號為 ③', !!vocabTab && /③/.test(vocabTab.label), vocabTab?vocabTab.label:'(無)');
    /* 編號必須連續不重複。注意：這裡在樣板字串內，regex 不可寫成 /[①②…]/，
       因為 [ 與 ] 沒問題，但為求一致仍用 new RegExp 組。 */
    var nums=tabs.map(function(t){return (t.label.match(new RegExp('['+CIRCLED+']'))||[''])[0];});
    ok('分頁編號不重複', nums.filter(function(n,i){return nums.indexOf(n)===i;}).length===nums.length,
      JSON.stringify(nums));
    ok('分頁編號為 ①..⑥ 共 6 個', nums.join('')===CIRCLED, JSON.stringify(nums));

    var view=document.getElementById('view');
    await RQ.teacher.render(view,'vocab');
    await wait(700);
    var vt=txt(view);
    ok('★ 老師端渲染出「生詞與默寫」畫面', /生詞與默寫/.test(vt));
    ok('有學生下拉選單', !!view.querySelector('select'),
      'select 數='+view.querySelectorAll('select').length);
    var sel=view.querySelector('select');
    if(sel){
      var os=opts(sel);
      ok('下拉選單列出名冊學生',
        os.some(function(o){return /陳小明/.test(o.text);}) && os.some(function(o){return /李小花/.test(o.text);}),
        JSON.stringify(os.map(function(o){return o.text;})));
    }
    ok('★ 看得到該生的生詞（老師代管）', /公園|散步|看見/.test(vt), vt.slice(0,160));
    ok('看得到「未學會」分類', /未學會/.test(vt));
    ok('看得到「已學會」分類', /已學會/.test(vt));
    ok('★ 老師有勾選框可維護', view.querySelectorAll('input[type=checkbox]').length>0,
      'checkbox 數='+view.querySelectorAll('input[type=checkbox]').length);
    var tb=btns(view);
    ok('★ 老師看得到「加入默寫範圍」鈕', tb.some(function(t){return /加入默寫範圍/.test(t);}), JSON.stringify(tb));
    var card=view.querySelector('.vb-board');
    ok('畫面有並排看板 .vb-board', !!card);

    /* 切換學生 → 內容要跟著換 */
    if(sel){
      var os2=opts(sel);
      var other=os2.filter(function(o){return /李小花/.test(o.text);})[0];
      if(other){
        sel.value=other.value;
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(700);
        var vt2=txt(view);
        ok('★ 切換學生後顯示該生資料（李小花無生詞）', !/散步/.test(vt2),
          vt2.slice(vt2.indexOf('生詞本與默寫範圍'), 220));
        ok('切換學生後狀態列跟著換', /李小花/.test(vt2)||/還沒有生詞/.test(vt2), vt2.slice(-200));
      }
    }

    /* ---------- B. 首頁不得列出所有試卷 ---------- */
    var HOMEFN = RQ.home;   /* app.js 有匯出（RQ.home）以便測試安全性行為 */
    ok('app.js 有匯出首頁函式（測試可驅動）', typeof HOMEFN==='function');
    var called = typeof HOMEFN === 'function';
    if (called) {
      /* B1：未登入訪客 */
      RQ.settings.set({session:null});
      var home=document.getElementById('view');
      HOMEFN();
      await wait(700);
      var ht=txt(home);
      /* ⚠ hero 區塊本身就有一顆「開始作答」按鈕（前往學生專區），
         所以不能直接數「開始作答」字串；要數的是「試卷卡片上的作答連結」，
         也就是 #/quiz/<id> 這種深連結。首頁不該出現任何一條。
         注意：這裡在樣板字串內，regex 不能寫 \/（會被展開成 /）。
         一律用 querySelectorAll 數連結，或用 String.fromCharCode 組字串。 */
      ok('★ 未登入首頁不含任何試卷深連結（#/quiz/…）',
        home.querySelectorAll('a[href*="#/quiz/"]').length===0,
        '連結數='+home.querySelectorAll('a[href*="#/quiz/"]').length);
      ok('★ 未登入首頁不洩漏任何試卷標題',
        !/已指派試卷|別人的試卷|不指派限制的試卷/.test(ht), ht.slice(0,180));
      ok('未登入首頁仍提供登入入口', /學生登入/.test(ht) && /老師登入/.test(ht), ht.slice(0,200));

      /* B2：學生身分 → 只給「前往我的作業」入口 */
      RQ.settings.set({session:{role:'student',id:S1,name:'陳小明',username:'s1'}});
      var home2=document.getElementById('view');
      HOMEFN();
      await wait(700);
      var ht2=txt(home2);
      ok('★ 學生首頁不列出試卷清單（無「別人的試卷」）', !/別人的試卷/.test(ht2), ht2.slice(0,180));
      ok('學生首頁提示「只會顯示老師指派給你的試卷」',
        /指派給你的試卷/.test(ht2), ht2.slice(0,220));

      /* B3：老師身分 → 只顯示概況 */
      RQ.settings.set({session:{role:'teacher',id:TID,name:'測試老師',username:'t'}});
      var home3=document.getElementById('view');
      HOMEFN();
      await wait(900);
      var ht3=txt(home3);
      ok('老師首頁顯示試卷總覽概況', /試卷總覽/.test(ht3), ht3.slice(0,180));
      ok('★ 老師首頁也不含試卷深連結（只給概況，不給作答入口）',
        home3.querySelectorAll('a[href*="#/quiz/"]').length===0,
        '連結數='+home3.querySelectorAll('a[href*="#/quiz/"]').length);
      ok('老師首頁提示去「試卷管理」指派', /試卷管理/.test(ht3), ht3.slice(0,240));
      /* 學生首頁也不能有試卷深連結 */
      ok('★ 學生首頁不含任何試卷深連結',
        home2.querySelectorAll('a[href*="#/quiz/"]').length===0,
        '連結數='+home2.querySelectorAll('a[href*="#/quiz/"]').length);
    }

    /* ---------- C. 直接打 #/quiz/<id> 也不能繞過指派 ---------- */
    var s1obj={id:S1,name:'陳小明',className:'中二A'};
    var s2obj={id:S2,name:'李小花',className:'中二B'};
    /* 前置核對：試卷確實寫得進去、讀得回來 */
    var backA=await B.getQuiz('qz_assigned');
    var backT=await B.getQuiz('qz_tom');
    ok('【前置】qz_assigned 讀得回來且帶 assignment',
      !!(backA && backA.assignment), backA?JSON.stringify(backA.assignment):'null');
    ok('【前置】S1 與 qz_assigned.assignment.ids[0] 一致',
      !!(backA && (backA.assignment.ids||[])[0]===S1));
    /* ⚠ isAssigned 收的是「整份試卷」（它自己找 .assignment）。
       傳 quiz.assignment 進去會永遠 false —— 這正是 gate 初版的 bug。 */
    ok('【約定】isAssigned 收整份試卷（傳 assignment 物件會失敗）',
      B.isAssigned(backA, s1obj)===true && B.isAssigned(backA.assignment, s1obj)===false,
      '整份='+B.isAssigned(backA,s1obj)+' / 片段='+B.isAssigned(backA.assignment,s1obj));

    /* C1：指派判定本身 */
    ok('★ isAssigned：qz_other 未指派給 s1', B.isAssigned(QUIZ_OTHER, s1obj)===false);
    ok('★ isAssigned：qz_assigned 有指派給 s1', B.isAssigned(QUIZ_ASSIGNED, s1obj)===true);
    ok('★ isAssigned：all:true 對所有人開放', B.isAssigned(QUIZ_FREE, s1obj)===true);
    ok('★ isAssigned：班別指派（qz_tom 屬中二B）不該命中中二A',
      B.isAssigned(QUIZ_TOM, s1obj)===false);
    ok('★ isAssigned：班別指派對該班學生命中',
      B.isAssigned(QUIZ_TOM, s2obj)===true);
    ok('★ isAssigned：完全沒有 assignment 視為未指派',
      B.isAssigned({id:'x',title:'無指派'}, s1obj)===false);
    ok('★ isAssigned：舊名冊只有 classes[] 也能命中班別',
      B.isAssigned({assignment:{classes:['中二B']}}, {id:'x',classes:['中二B']})===true);
    ok('assignReason 說明命中方式',
      B.assignReason(QUIZ_ASSIGNED, s1obj)==='指定個人',
      B.assignReason(QUIZ_ASSIGNED, s1obj));


    /* 實際渲染路由：學生打 #/quiz/qz_other */
    RQ.settings.set({session:{role:'student',id:S1,name:'陳小明',username:'s1'},
      policy:{assignOnly:true}});
    var qv=document.getElementById('view');
    await RQ.student.take(qv,'qz_other');
    await wait(700);
    var qt=txt(qv);
    ok('★ 未指派的試卷被擋下（顯示「沒有指派給你」）',
      /沒有指派給你/.test(qt), qt.slice(0,150));
    ok('★ 未指派的試卷不會進入作答畫面', !/提交作答|送出/.test(qt), qt.slice(0,150));

    /* 已指派的試卷 → 正常進入 */
    var qv2=document.getElementById('view');
    await RQ.student.take(qv2,'qz_assigned');
    await wait(700);
    var qt2=txt(qv2);
    ok('★ 已指派的試卷可以正常進入作答', !/沒有指派給你/.test(qt2), qt2.slice(0,150));
    ok('已指派試卷確實渲染出作答介面（有提交鈕）', /提交作答/.test(qt2), qt2.slice(0,200));

    /* C2：assignOnly=false 時不擋（老師刻意開放） */
    RQ.settings.set({session:{role:'student',id:S1,name:'陳小明',username:'s1'},
      policy:{assignOnly:false}});
    var qv3=document.getElementById('view');
    await RQ.student.take(qv3,'qz_other');
    await wait(700);
    var qt3=txt(qv3);
    ok('★ assignOnly=false 時未指派試卷不擋（尊重老師設定）',
      !/沒有指派給你/.test(qt3), qt3.slice(0,150));

    /* C3：雲端發佈的政策要蓋過學生本機設定（防止改 devtools 解鎖） */
    RQ.settings.set({session:{role:'student',id:S1,name:'陳小明',username:'s1'},
      policy:{assignOnly:false}});
    RQ.backend._publishedPolicy={assignOnly:true};
    ok('★ 雲端政策優先於學生本機設定（學生改本機也解不開）',
      RQ.backend.policy('assignOnly')===true, 'policy='+RQ.backend.policy('assignOnly'));
    var qv4=document.getElementById('view');
    await RQ.student.take(qv4,'qz_other');
    await wait(700);
    ok('★ 即使本機改成 false，未指派試卷仍被擋',
      /沒有指派給你/.test(txt(qv4)), txt(qv4).slice(0,150));
    /* 老師裝置不受雲端政策限制（老師要能預覽全部） */
    RQ.settings.set({session:{role:'teacher',id:'t_x',name:'老師',username:'t'},
      gh:{owner:'o',repo:'r',branch:'main',token:'faketoken'}, policy:{assignOnly:false}});
    ok('★ 老師裝置以本機設定為準（雲端政策不限制老師）',
      RQ.backend.policy('assignOnly')===false, 'policy='+RQ.backend.policy('assignOnly'));
    RQ.backend._publishedPolicy=null;

    finish();
  }catch(e){
    out.push(['EXCEPTION',false,(e&&e.stack)||String(e)]);
    finish();
  }
})();
<\/script>
</body></html>`;

let pagePath = '';
server.listen(0, '127.0.0.1', function () {
  const port = server.address().port;
  pagePath = path.join(ROOT, 'tools', '_teacher_vocab.html');
  fs.writeFileSync(pagePath, PAGE, 'utf8');

  const url = 'http://127.0.0.1:' + port + '/tools/_teacher_vocab.html';
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'rq-tv-' + Date.now()),
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
      try {
        const dump = path.join(ROOT, 'tools', '_tv_dump.txt');
        fs.writeFileSync(dump, out, 'utf8');
        console.log('原始 dump 已寫入 tools/_tv_dump.txt（bytes=' + out.length + '）');
      } catch (e) { }
      console.log('dump 有 <body>:', out.indexOf('<body') >= 0,
        '| 有 id="RESULTS":', out.indexOf('id="RESULTS"') >= 0);
      const bi = out.indexOf('<body');
      if (bi >= 0) console.log('body 內容片段:', out.slice(bi, bi + 400).replace(/\s+/g, ' '));
      console.log('--- stderr ---');
      console.log((errout.split('\n').filter(l => /error|Error|fail|refus/i.test(l)).slice(0, 10).join('\n')) || '(無)');
      server.close(); process.exit(1);
    }
    const txtOut = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    console.log(txtOut);
    const fails = (txtOut.match(/^FAIL/gm) || []).length;
    server.close();
    process.exit(fails ? 1 : 0);
  });
});

setTimeout(() => { console.log('❌ 總逾時'); try { server.close(); } catch (e) { } process.exit(1); }, 180000);
