/* 驗證 GitHub.write 的「409 衝突自動重試」與 no-store 快取設定。
   不需要真的連 GitHub：用假 fetch 模擬「讀到舊 sha → PUT 被拒絕 → 重讀新 sha → 成功」。
   用法：node tools/_test_github_write.js                                    */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';

global.window = global;
global.window.RQ = {
  util: {
    nowISO: function () { return new Date().toISOString(); },
    trim: function (s) { return String(s == null ? '' : s).trim(); }
  },
  store: { kv: {}, quiz: {} },
  settings: {
    get: function () {
      return { gh: { owner: 'o', repo: 'r', branch: 'main', token: 't', path: 'data' }, fb: {}, hook: {} };
    }
  },
  crypto: {}
};

/* ---- 假 fetch ----
   mode='once'  ：第一次 GET 回舊 sha（模擬讀到快取／被別人改過），之後回真正 sha → 重試會成功
   mode='always'：每次 GET 都回不同的新 sha → PUT 永遠對不上 → 應該重試 3 次後放棄     */
const calls = [];
let mode = 'once';
let currentSha = 'real-sha';
let putAttempts = 0;
let getCount = 0;

global.fetch = function (url, init) {
  calls.push({ url: String(url), method: (init && init.method) || 'GET', cache: init && init.cache, body: init && init.body });
  if (init && init.method === 'PUT') {
    putAttempts++;
    const body = JSON.parse(init.body);
    if (body.sha !== currentSha) {
      return Promise.resolve({
        ok: false, status: 409,
        json: () => Promise.resolve({ message: 'data/quizzes/index.json does not match ' + body.sha })
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: {}, sha: currentSha }) });
  }
  getCount++;
  let sha = currentSha;
  if (mode === 'once' && getCount === 1) sha = 'stale-sha';          // 讀到舊 sha
  if (mode === 'always') sha = 'sha-' + getCount;                    // 永遠對不上
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ content: Buffer.from('[]').toString('base64'), sha: sha, path: 'x' })
  });
};

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets/js/core/backend.js'), 'utf8'));
const GH = global.window.RQ.backend.GitHub;

(async function () {
  let pass = 0, fail = 0;
  function check(name, ok, extra) {
    if (ok) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
  }

  const okWrite = await GH.write('data/quizzes/index.json', [{ id: 'x' }], 'test').then(() => true).catch(() => false);
  check('寫入遇到 409 會自動重試並成功', okWrite);
  check('PUT 被拒絕後有重讀 sha 再送（共 2 次 PUT）', putAttempts === 2, 'putAttempts=' + putAttempts);
  const gets = calls.filter(c => c.method === 'GET');
  check('所有 GitHub API 讀取都帶 cache:no-store（避免讀到快取舊 sha）',
    gets.length > 0 && gets.every(g => g.cache === 'no-store'),
    'gets=' + gets.length + ' 帶 no-store=' + gets.filter(g => g.cache === 'no-store').length);

  /* ---- 一直衝突時：重試 3 次後給出可行動的錯誤訊息 ---- */
  mode = 'always'; putAttempts = 0; getCount = 0; calls.length = 0;
  const err = await GH.write('data/quizzes/index.json', [], 'test').then(() => null).catch(e => e.message);
  check('持續衝突時會放棄並給出可行動的訊息', !!err && /再按一次|同時被更新/.test(err), String(err));
  check('最多重試 3 次（不會無限迴圈）', putAttempts === 3, 'putAttempts=' + putAttempts);

  console.log('\nGITHUB WRITE TEST:', pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
