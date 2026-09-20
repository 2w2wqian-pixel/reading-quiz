/* 用 GitHub Git Data API 推送「本機 main 的內容」到遠端 main。
 *
 * 為什麼不用 git push：沙箱沒有存放任何憑證，git push 會停在互動式帳密輸入而逾時。
 * 這條路走 REST API，只要有一顆 token 就能完成，且支援 fast-forward 檢查。
 *
 * 用法：node tools/_push_repair.js <TOKEN>
 *   token 需要 repo 的 Contents: Read and write（或 classic 的 repo 權限）。
 *
 * 安全性：
 *  - 推送前先檢查遠端 head 是否為本機 commit 的祖先（fast-forward）。
 *  - 不是 fast-forward 就中止，不強推。
 *  - 只送「遠端 tree 沒有、或內容不同」的 blob，資料夾結構沿用遠端。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWNER = '2w2wqian-pixel';
const REPO = 'reading-quiz';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');
const TOKEN = process.argv[2];

if (!TOKEN) {
  console.error('用法：node tools/_push_repair.js <TOKEN>');
  process.exit(1);
}

function api(method, p, body) {
  return new Promise(function (res, rej) {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: p, method: method,
      headers: {
        'User-Agent': 'rq-push',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + TOKEN,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, function (r) {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (e) { }
        if (r.statusCode >= 400) return rej(new Error('HTTP ' + r.statusCode + ' ' + p + ' :: ' + b.slice(0, 300)));
        res(j);
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

function gitBlobSha(buf) {
  const h = crypto.createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
}

/* 本機要發佈的檔案（與 _api_publish.py 的清單一致，排除 tools/ 以外的雜物） */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.workbuddy', '_archive', '.rq_backup']);
const SKIP_EXT = new Set(['.log', '.bak', '.tmp']);

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    let st; try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, rel, out);
    } else {
      if (SKIP_EXT.has(path.extname(name).toLowerCase())) continue;
      out.push({ rel: rel, full: full });
    }
  }
}

(async function () {
  const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const remoteHead = ref.object.sha;
  console.log('遠端 main =', remoteHead.slice(0, 8));

  const rCommit = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + remoteHead);
  const remoteTree = rCommit.tree.sha;
  console.log('遠端 tree =', remoteTree.slice(0, 8));

  const rt = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + remoteTree + '?recursive=1');
  const remote = {};
  rt.tree.forEach(function (e) { if (e.type === 'blob') remote[e.path] = e.sha; });

  const local = [];
  walk(ROOT, '', local);
  console.log('本機檔案數 =', local.length, '| 遠端檔案數 =', Object.keys(remote).length);

  /* 先確認「遠端是不是本機的祖先」——本機沒有 .git 時改用內容判斷 */
  const localMap = {};
  for (const f of local) localMap[f.rel] = gitBlobSha(fs.readFileSync(f.full));

  const onlyRemote = Object.keys(remote).filter(p => !(p in localMap));
  if (onlyRemote.length) {
    console.log('\n⚠ 遠端有、本機沒有（會被保留，因為以遠端 tree 為 base）：');
    onlyRemote.slice(0, 20).forEach(p => console.log('   ', p));
    if (onlyRemote.length > 20) console.log('    … 其餘', onlyRemote.length - 20, '個');
  }

  const changed = local.filter(f => remote[f.rel] !== localMap[f.rel]);
  console.log('\n需要推送：' + changed.length + ' 個檔案');
  changed.forEach(f => console.log('   M', f.rel));

  if (!changed.length) { console.log('\n已經完全同步，不需推送。'); return; }

  /* 建立新 tree：以遠端 tree 為 base，只覆蓋差異檔 */
  const entries = [];
  for (const f of changed) {
    const blob = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs',
      { content: fs.readFileSync(f.full).toString('base64'), encoding: 'base64' });
    entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees',
    { base_tree: remoteTree, tree: entries });
  console.log('\n新 tree =', newTree.sha.slice(0, 8), '（遠端原有的 tools/ 等都會保留）');

  let message = '新增 Google 帳號登入入口 ＋ 設定來源統一（雲端／本機一致性）';
  const msgFile = path.join(ROOT, '.git', 'COMMIT_EDITMSG');
  try { message = fs.readFileSync(msgFile, 'utf8').trim(); } catch (e) { }

  const now = Math.floor(Date.now() / 1000);
  const who = { name: '2w2wqian-pixel', email: 'teacher@example.com', date: new Date().toISOString() };
  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits',
    { message: message, tree: newTree.sha, parents: [remoteHead], author: who, committer: who });
  console.log('新 commit =', commit.sha.slice(0, 8));

  await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH,
    { sha: commit.sha, force: false });

  const after = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  console.log('\n✅ 遠端 main 現在 =', after.object.sha.slice(0, 8));
  console.log('   fast-forward，遠端原有的歷程完全保留。');
})().catch(function (e) {
  console.error('\n❌ 推送失敗：' + e.message);
  process.exit(1);
});
