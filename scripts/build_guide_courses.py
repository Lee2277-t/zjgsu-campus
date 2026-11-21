import sys, os, json, hashlib, re
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, r'D:\recon\scripts')
import prepare_course_review_import as p

rows = json.load(open(os.path.join(p.DATA, 'candidates.json'), encoding='utf-8'))
existing = {p.norm_name(c['name']) for c in p.COURSES}

MANUAL = {
    '大英': '大学英语',
    '大英2': '大学英语2',
    '大英3': '大学英语3',
    '大英4': '大学英语4',
    '大英四': '大学英语4',
    '大英4求推荐': '大学英语4',
    '大英5': '大学英语5',
    '大学英语2': '大学英语2',
    '中外电影叙述赏析': '中外电影叙事赏析',
    '影武者 动作片与电影美学赏析': '影武者：动作片与电影美学赏析',
    '影武者—动作片与电影美学赏析': '影武者：动作片与电影美学赏析',
    '美国流行音乐': '美国流行音乐鉴赏',
    '初级气排球': '气排球',
    '中级气排球': '气排球',
    '初级女子足球': '女子足球',
    '初级旱地冰壶': '旱地冰壶',
    '中外电影名著改编（2学分）': '中外电影名著改编',
    '古今数学思想（2学分）': '古今数学思想',
    '数学建模与思维创新（2学分）': '数学建模与思维创新',
    '视觉文化与社会性别（网课）': '视觉文化与社会性别',
    '习近平新中国特色社会主义概论': '习近平新时代中国特色社会主义思想概论',
    '线性代数实践与MATLAB入门': '线性代数实践及MATLAB入门',
}

def canonical(raw):
    s = p.txt(raw)
    s = re.sub(r'^(求问|求推荐|求评价|求|请问|想问)', '', s).strip()
    s = re.sub(r'(求推荐|求评价|求问|求求|！|!)$', '', s).strip()
    s = s.replace('（2学分）', '').replace('(2学分)', '').replace('（网课）', '').strip()
    s = MANUAL.get(s, s)
    return s

skip_norm = {
    p.norm_name(x) for x in [
        '会计学', '宏观经济学', '消费者行为学', '(空)', '求问中级武术', '大英三'
    ]
}
seen = {}
for r in rows:
    if r['courseMatch'] in ('matched', 'teacher_only'):
        continue
    raw = p.txt(r['courseRaw'])
    if not raw:
        continue
    cname = canonical(raw)
    n = p.norm_name(cname)
    if not n or n in skip_norm:
        continue
    if re.search(r'(qg:/|支fu宝|支付宝|扫码|加微信|怎么样|怎么算|求推荐|求问|求求)', cname, re.I):
        continue
    if n in existing:
        continue
    item = seen.setdefault(cname, {'name': cname, 'sheets': set(), 'raws': set()})
    item['sheets'].add(r['sourceSheet'])
    item['raws'].add(raw)

courses = []
for i, (name, item) in enumerate(sorted(seen.items()), 1):
    sheets = item['sheets']
    if '体育课' in sheets:
        college, major, ctype = '体育工作部', '体育选项课', '体育课'
    elif '大英' in sheets:
        college, major, ctype = '外国语学院', '大学英语', '通识课'
    elif '形策' in sheets or '近代史马原毛概' in sheets:
        college, major, ctype = '马克思主义学院', '本科生思政课', '思政课'
    elif '专业课' in sheets:
        college, major, ctype = '待确认', '专业课', '专业课'
    else:
        college, major, ctype = '通识教育中心（网络通识课）', '通识教育', '通识课'
    hid = hashlib.sha1(name.encode('utf-8')).hexdigest()[:10]
    courses.append({
        'id': 'guide-' + hid,
        'name': name,
        'college': college,
        'major': major,
        'credit': None,
        'tags': [],
        'ctype': ctype,
        'description': '根据学生选课指南整理；具体开课与学分以教务系统为准。',
        'source': '学生选课指南（2026-10）',
        'sourceVersion': '2026-10',
        'builtin': True,
        'rawNames': sorted(item['raws'])
    })

out = os.path.join(p.DATA, 'guide-courses.json')
json.dump(courses, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('new courses', len(courses), '->', out)
for c in courses:
    print(c['id'], c['name'], '|', c['ctype'], '|', ','.join(c['rawNames']))
