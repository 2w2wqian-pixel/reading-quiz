# 造出 E2E 測試用的「假 repo」：<fixdir>/quizzes/index.json + 兩份試卷 json。
# 目的：測試完全不碰 data/（老師真正的試卷與名冊）。
# 用法：python tools/_e2e_fixture.py <fixdir> <中文試卷 id>
import json, os, sys

fix, qid = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(fix, 'quizzes'), exist_ok=True)

FIXED_META = {
    "questionCount": 1, "totalMarks": 3, "passageCount": 0, "published": True,
    "createdAt": "2026-09-17T00:00:00.000Z",
}
ITEMS = [
    ('demo-f2-r-t01', '中二學期試卷(01)閱讀能力考核', '中二'),
    (qid, '中六卷一閱讀能力考核（已發佈）', '中六'),
]

for i, title, level in ITEMS:
    quiz = {
        "id": i, "title": title, "level": level, "source": "e2e", "published": True,
        "totalMarks": 3, "passages": [],
        "questions": [{"no": 1, "id": "q1", "type": "text", "stem": "試解釋文意。", "marks": 3}],
        "createdAt": "2026-09-17T00:00:00.000Z",
    }
    with open(os.path.join(fix, 'quizzes', i + '.json'), 'w', encoding='utf-8') as f:
        json.dump(quiz, f, ensure_ascii=False, indent=2)
    print('fixture quiz:', i)

idx = [dict(id=i, title=t, level=lv, **FIXED_META) for i, t, lv in ITEMS]
with open(os.path.join(fix, 'quizzes', 'index.json'), 'w', encoding='utf-8') as f:
    json.dump(idx, f, ensure_ascii=False, indent=2)
print('fixture index:', [x['id'] for x in idx])
