# 用 GitHub Git Data API 把「本機目前的檔案內容」發佈成遠端 main 的新 commit。
#
# 為什麼需要它：沙箱的 git push 有時會卡住十幾分鐘甚至完全沒反應，
# 這條路走 REST API（blob → tree → commit → 更新 ref），通常幾秒完成。
#
# 設計重點：
#  1. 以「遠端 tree」為 base，比對「本機 tree」，只送有差異的檔案
#     （不是只看最後一個 commit 的 diff —— 否則中間沒推成功的 commit 會漏掉）。
#  2. 比對的是 blob sha，所以 CRLF/換行差異不會造成假變更。
#  3. 安全鎖：若遠端 data/ 底下有本機沒同步的內容（老師在瀏覽器剛發佈的試卷），
#     一律中止，避免覆蓋掉老師的資料。
#  4. 沿用本機 HEAD 的 author/committer/時間與訊息，重建出「完全相同」的 commit；
#     若遠端就在本機 parent 上，產生的 sha 會與本機一致（兩邊不分歧）。
#
# 用法：python tools/_api_publish.py <TOKEN> [--force-base]
#   --force-base：允許遠端已前進時仍發佈（仍會通過 data/ 安全鎖）
#   --force-data=data/config.json,data/roster.json
#                 明確允許覆蓋指定的 data/ 檔案。安全鎖原本會擋下「所有」data/ 內容差異，
#                 但我們有時就是**刻意**要改資料（例如把雲端名冊補進 repo）。
#                 加了這個參數才會放行，而且會印出「遠端有、本機沒有」的欄位或項目，
#                 讓覆蓋成為一個有意識、可稽核的決定，而不是靜默覆蓋。
import base64, json, re, subprocess, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

TOKEN = sys.argv[1]
FORCE = '--force-base' in sys.argv
FORCE_DATA = []
for _a in sys.argv[1:]:
    if _a.startswith('--force-data='):
        FORCE_DATA = [x.strip() for x in _a.split('=', 1)[1].split(',') if x.strip()]
OWNER, REPO, BRANCH = '2w2wqian-pixel', 'reading-quiz', 'main'
API = 'https://api.github.com'


def sh(*args):
    r = subprocess.run(args, capture_output=True)
    if r.returncode:
        print('git 失敗:', args, r.stderr.decode()[:300]); sys.exit(1)
    return r.stdout


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, path, e.read().decode()[:400]); raise


def local_tree_map():
    """本機 HEAD 的 [路徑] = blob sha（用 -z 避免非 ASCII 檔名被轉義）"""
    out = {}
    for chunk in [c for c in sh('git', 'ls-tree', '-r', '-z', 'HEAD').decode('utf-8').split('\0') if c]:
        meta, path = chunk.split('\t', 1)
        out[path] = meta.split(' ')[2]
    return out


def remote_tree_map(tree_sha):
    rt = api('GET', '/repos/%s/%s/git/trees/%s?recursive=1' % (OWNER, REPO, tree_sha))
    return {e['path']: e['sha'] for e in rt.get('tree', []) if e['type'] == 'blob'}


def blob_b64(path):
    return base64.b64encode(sh('git', 'cat-file', 'blob', 'HEAD:' + path)).decode()


def remote_blob_text(sha):
    j = api('GET', '/repos/%s/%s/git/blobs/%s' % (OWNER, REPO, sha))
    if j.get('encoding') == 'base64':
        return base64.b64decode(j['content']).decode('utf-8')
    return j.get('content', '')


def _keyof(item):
    if isinstance(item, dict):
        for k in ('id', 'username', 'name', 'title'):
            if k in item:
                return str(item[k])
    return None


def describe_loss(path, remote_sha):
    """覆蓋前把「遠端版本 → 本機版本」的差異講清楚（尤其是會遺失的部分）。"""
    try:
        old = json.loads(remote_blob_text(remote_sha))
        new = json.loads(sh('git', 'cat-file', 'blob', 'HEAD:' + path).decode('utf-8'))
    except Exception as e:
        print('      （無法比較內容：%s）' % e)
        return
    if isinstance(old, dict) and isinstance(new, dict):
        lost = sorted(set(old) - set(new))
        chg = sorted(k for k in set(old) & set(new) if old[k] != new[k])
        add = sorted(set(new) - set(old))
        if lost:
            print('      ⚠ 遠端有、本機沒有的欄位（會遺失）：', lost)
        if chg:
            print('      變更欄位：', chg)
        if add:
            print('      新增欄位：', add)
    elif isinstance(old, list) and isinstance(new, list):
        o = {_keyof(x): x for x in old}
        n = {_keyof(x): x for x in new}
        lost = [k for k in o if k not in n]
        add = [k for k in n if k not in o]
        chg = [k for k in o if k in n and o[k] != n[k]]
        if lost:
            print('      ⚠ 遠端有、本機沒有的項目（會遺失）：', lost)
        if chg:
            print('      變更項目：', chg)
        if add:
            print('      新增項目：', add)
    else:
        print('      （型別不同或非 JSON：只能整檔覆蓋）')


def main():
    head = sh('git', 'rev-parse', 'HEAD').decode().strip()
    raw = sh('git', 'cat-file', 'commit', 'HEAD').decode('utf-8')

    def ident(line):
        m = re.match(r'^(?:author|committer)\s+(.*?)\s+<([^>]*)>\s+(\d+)\s+([+-]\d{4})$', line)
        if not m:
            raise SystemExit('無法解析 commit 的 ' + line[:20])
        name, mail, epoch, tz = m.group(1), m.group(2), int(m.group(3)), m.group(4)
        sign = 1 if tz[0] == '+' else -1
        offset = timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5])) * sign
        return {'name': name, 'email': mail,
                'date': datetime.fromtimestamp(epoch, timezone(offset)).isoformat()}

    lines = raw.split('\n')
    author = ident([l for l in lines if l.startswith('author ')][0])
    committer = ident([l for l in lines if l.startswith('committer ')][0])
    message = raw.split('\n\n', 1)[1]

    ref = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPO, BRANCH))
    base = ref['object']['sha']
    base_tree = api('GET', '/repos/%s/%s/git/commits/%s' % (OWNER, REPO, base))['tree']['sha']

    remote, local = remote_tree_map(base_tree), local_tree_map()
    print('遠端 main =', base[:8], '| 本機 HEAD =', head[:8])

    # ---- 安全鎖：data/ 底下遠端有的，本機一定要有且相同 ----
    bad = [p for p in remote if p.startswith('data/') and remote[p] != local.get(p)]
    forced = [p for p in bad if p in FORCE_DATA]
    blocking = [p for p in bad if p not in FORCE_DATA]
    if forced:
        print('※ 明確允許覆蓋（--force-data）：')
        for p in forced:
            print('   ', p)
            describe_loss(p, remote[p])
    if blocking:
        print('!! 遠端 data/ 有本機沒同步的內容（老師剛發佈的試卷？），中止以免覆蓋：')
        for p in blocking[:10]:
            print('   ', p)
        print('   → 請先把 data/ 同步下來再發佈。')
        print('   → 若確認要覆蓋，請加上 --force-data=' + ','.join(blocking[:4]))
        sys.exit(3)

    if not FORCE and base != sh('git', 'rev-parse', 'HEAD^').decode().strip():
        # 遠端不在本機 parent 上：照樣可以發佈（用遠端 tree 當 base），但提醒一下
        print('（提醒）遠端不在本機 parent 上，將以遠端 tree 為基底更新差異檔案')

    changed = [p for p in local if remote.get(p) != local[p]]
    removed = [p for p in remote if p not in local and not p.startswith('data/')]
    print('要更新 %d 個檔案，刪除 %d 個：' % (len(changed), len(removed)))
    for p in sorted(changed)[:20]:
        print('   M', p)
    for p in sorted(removed)[:10]:
        print('   D', p)

    entries = []
    for p in changed:
        blob = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO),
                   {'content': blob_b64(p), 'encoding': 'base64'})
        entries.append({'path': p, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    for p in removed:
        entries.append({'path': p, 'mode': '100644', 'type': 'blob', 'sha': None})

    new_tree = api('POST', '/repos/%s/%s/git/trees' % (OWNER, REPO),
                   {'base_tree': base_tree, 'tree': entries})
    local_top = sh('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    print('新 tree =', new_tree['sha'][:8], '| 本機 tree =', local_top[:8],
          '✅ 一致' if new_tree['sha'] == local_top else '（不同：遠端還有本機沒有的檔案，例如老師的 data/）')

    commit = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO),
                 {'message': message, 'tree': new_tree['sha'], 'parents': [base],
                  'author': author, 'committer': committer})
    print('新 commit =', commit['sha'][:8], '| 本機 =', head[:8],
          '✅ 相同' if commit['sha'] == head else '（內容相同即可）')

    api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPO, BRANCH),
        {'sha': commit['sha'], 'force': False})
    now = api('GET', '/repos/%s/%s/commits/%s' % (OWNER, REPO, BRANCH))
    print('遠端 main 現在 =', now['sha'][:8], '|', now['commit']['message'].split('\n')[0][:44])


main()
