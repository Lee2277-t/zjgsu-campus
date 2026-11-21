import sys, os, json, re, csv, math, hashlib
from difflib import SequenceMatcher
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, r'D:\recon\.tmp_pylibs')
import pandas as pd

ROOT = r'D:\recon'
SRC = r'D:\wechat_files\wxid_EXAMPLE\msg\file\2026-10'
DATA = os.path.join(ROOT, 'data', 'course-review-import')
os.makedirs(DATA, exist_ok=True)

FILES = [
    ('浙小商选课指南.xlsx.xlsx', '指南'),
    ('浙小商通识课总表.xls', '总表'),
    ('浙小商通识课避雷针.xls', '避雷针'),
    ('选课推荐.xlsx', '选课推荐'),
    ('通识课小纸条.xls', '小纸条'),
]

def txt(v):
    if v is None:
        return ''
    if isinstance(v, float) and math.isnan(v):
        return ''
    s = str(v).replace('\r', ' ').replace('\n', ' ').strip()
    s = re.sub(r'\s+', ' ', s)
    return s

def norm_name(s):
    s = txt(s)
    s = re.sub(r'[《》<>“”"\'·,，。.!！?？:：;；\-—_/\\|（）()\[\]【】]', '', s)
    s = re.sub(r'\s+', '', s)
    # 表单里的提问词不是课程名
    s = re.sub(r'^(求问|求推荐|求评价|求|请问|想问|蹲一个|蹲)', '', s)
    s = re.sub(r'(求推荐|求评价|同问|有推荐吗|怎么样|求问|有无推荐|推荐吗|求避雷|蹲一个|蹲|同求)$', '', s)
    return s.lower()

def is_noise(s):
    t = txt(s)
    n = norm_name(t)
    if n in {'', '求推荐', '求评价', '同问', '求问', '蹲', '蹲一个', '有推荐吗', '怎么样',
             '同求', '求避雷', '有无推荐', '推荐吗', '求老师', '求避雷针',
             '求个评价', '求个评价谢谢', '求推荐谢谢', '求评价谢谢', '这个怎么样', '这个咋样',
             '这个如何', '这门课怎么样', '这课怎么样', '怎么样哇', '怎么样啊', '求感受'}:
        return True
    # 只有提问/求推荐、没有陈述信息的短句
    if re.fullmatch(r'(求个?|求|蹲|请问|想问|问一下)?(评价|推荐|避雷|感受|问|课评)?[，,。.!！?？\s]*', n):
        return True
    if ('求评价' in n or '求推荐' in n or '求避雷' in n or '同问' in n or '同求' in n) and len(n) <= 20:
        return True
    if ('还是好课还是雷课' in n or '是好课还是雷课' in n or '挺急' in n or '急求' in n):
        return True
    if '吗' in n and ('谢谢' in n or len(n) <= 14):
        return True
    if re.search(r'(吗|嘛|么)$', n) and len(n) <= 12:
        return True
    if re.match(r'^(大英|大学英语)[一二三四五1-5]?$', n):
        return True
    if n in {'雷不雷','雷不雷啊','给分怎么样','给分怎么样啊','这个雷吗','分是怎么算的呀','这个怎么样啊','这个如何啊'}:
        return True
    return False

def scrub_content(s):
    """去掉与其他人的提问混在一条正文里的纯提问段，保留实际体验。"""
    raw = txt(s)
    # 去掉表格里夹在正文中的提问括号，例如“[给分怎么样？]”“（求评价）”
    raw = re.sub(r'\[[^\]]*(怎么样|求评价|求推荐|求问|同问|给分怎么样|给分高吗|有趣吗)[^\]]*\]', '', raw)
    raw = re.sub(r'（[^）]*(怎么样|求评价|求推荐|求问|同问|给分怎么样|给分高吗|有趣吗)[^）]*）', '', raw)
    raw = re.sub(r'\([^)]*(怎么样|求评价|求推荐|求问|同问|给分怎么样|给分高吗|有趣吗)[^)]*\)', '', raw)
    # 问句和体验经常被同一格里的“/”或问号混在一起：只保留陈述体验的部分
    parts = re.split(r'[\n/｜|？?；;]+', raw)
    keep = []
    for part in parts:
        p = txt(part)
        if not p:
            continue
        if is_noise(p):
            continue
        # 去掉句首的提问腔，但保留后面的实际体验
        p = re.sub(r'^(这个|这门课|这课|那个)?(怎么样|咋样|如何|求评价|求推荐|求问|求感受|有推荐吗|有无推荐)[啊呀呢哇？?，,、\s]*', '', p)
        p = re.sub(r'^(请问|想问一下|想问|问一下)[，,、\s]*', '', p)
        p = p.strip(' ，,、/')
        if p and not is_noise(p):
            keep.append(p)
    return '；'.join(keep) if keep else raw

def load_courses():
    base = os.path.join(ROOT, 'miniprogram', 'zjgsu-campus', 'data')
    src = open(os.path.join(base, 'seed.js'), encoding='utf-8').read()
    st = src.index('const rawCourses = ')
    st = src.index('{', st)
    depth = 0; in_str = False; esc = False; en = None
    for i in range(st, len(src)):
        ch = src[i]
        if in_str:
            if esc: esc = False
            elif ch == '\\': esc = True
            elif ch == '"': in_str = False
            continue
        if ch == '"': in_str = True
        elif ch == '{': depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                en = i + 1
                break
    raw = json.loads(src[st:en])
    courses = []; cid = 0
    for college, majors in raw.items():
        for major, names in majors.items():
            for name in names:
                if not name: continue
                cid += 1
                courses.append({'id': 'c' + str(cid), 'name': name, 'college': college,
                                'major': major, 'ctype': '专业课'})
    for fn in ['courses-extra.js', 'courses-extra-history.js', 'courses-political.js']:
        t = open(os.path.join(base, fn), encoding='utf-8').read()
        i = t.find('['); j = t.rfind(']')
        arr = json.loads(t[i:j+1])
        for c in arr:
            if c and c.get('name') and c.get('id'):
                courses.append(c)
    # 选课指南里确实存在、但官方 seed 没收录的课程：用云端补课，不塞进主包
    guide_path = os.path.join(ROOT, 'data', 'course-review-import', 'guide-courses.json')
    if os.path.exists(guide_path):
        seen = {c.get('id') for c in courses}
        for c in json.load(open(guide_path, encoding='utf-8')):
            if c.get('id') and c.get('name') and c['id'] not in seen:
                courses.append(c)
    return courses

def load_teachers():
    x = json.load(open(os.path.join(ROOT, 'data', 'zjgsu-teachers-all.json'), encoding='utf-8'))
    arr = x.get('teachers', []) if isinstance(x, dict) else x
    out = {}
    for t in arr:
        n = norm_name(t.get('name', ''))
        if not n: continue
        out.setdefault(n, []).append(t)
    return out

COURSES = load_courses()
TEACHERS = load_teachers()
BY_NORM = {}
BY_NAME = {}
for c in COURSES:
    BY_NORM.setdefault(norm_name(c['name']), []).append(c)
    BY_NAME.setdefault(txt(c['name']), []).append(c)

ALIASES = {
    '毛概': ['毛泽东思想和中国特色社会主义理论体系概论'],
    '马原': ['马克思主义基本原理概论'],
    '形策': ['形势与政策'],
    '行策': ['形势与政策'],
    '近代史': ['中国近现代史纲要'],
    '思修': ['思想道德修养与法律基础'],
    '百年风流人物曾国潘': ['百年风流人物：曾国藩'],
    '创新工程实践课': ['创新工程实践'],
    '二外日语': ['二外'],
    '英语演讲与辩论下': ['英语演讲与辩论'],
    '创新思维与训练': ['创新思维训练'],
    '生活中的经济法': ['生活中的经济法问题'],
    '石头的鉴赏和收藏': ['石头的鉴赏与收藏'],
    '数学建模与思维创新2学分': ['数学建模与思维创新'],
    '视觉文化与社会性别网课': ['视觉文化与社会性别'],
    '人力资源概论': ['人力资源管理概论'],
    '韩国文化': ['韩国文化的理解'],
    '韩国文化与理解': ['韩国文化的理解'],
    '近现代': ['中国近现代史纲要'],
    '近代史纲要': ['中国近现代史纲要'],
    '形策1': ['形势与政策'],
    '形策6': ['形势与政策'],
    '行策1': ['形势与政策'],
    '大英': ['大学英语'],
    '大英2': ['大学英语2'],
    '大英3': ['大学英语3'],
    '大英4': ['大学英语4'],
    '大英四': ['大学英语4'],
    '大英4求推荐': ['大学英语4'],
    '大英5': ['大学英语5'],
    '初级气排球': ['气排球'],
    '中级气排球': ['气排球'],
    '初级旱地冰壶': ['旱地冰壶'],
    '初级女子足球': ['女子足球'],
    '中外电影叙述赏析': ['中外电影叙事赏析'],
    '影武者 动作片与电影美学赏析': ['影武者：动作片与电影美学赏析'],
    '影武者—动作片与电影美学赏析': ['影武者：动作片与电影美学赏析'],
    '美国流行音乐': ['美国流行音乐鉴赏'],
    '中外电影名著改编2学分': ['中外电影名著改编'],
    '线性代数实践与MATLAB入门': ['线性代数实践及MATLAB入门'],
    '习近平新中国特色社会主义概论': ['习近平新时代中国特色社会主义思想概论'],
    '古今数学思想2学分': ['古今数学思想'],
}
# 别名键统一走 norm_name，避免 MATLAB/MIB 这种大写字母导致匹配失败
ALIASES = {norm_name(k): v for k, v in ALIASES.items()}

TYPE_FILTER = {
    '通识课': {'通识课'},
    '体育课': {'体育课'},
    '专业课': {'专业课'},
    '形策': {'思政课'},
    '近代史马原毛概': {'思政课'},
    '大英': {'通识课', '专业课'},
}

def filter_type(cands, sheet):
    want = TYPE_FILTER.get(sheet)
    if not want: return cands
    hit = [c for c in cands if c.get('ctype') in want]
    return hit or cands

def refine_courses(cands, sheet, teacher_college='', raw=''):
    cands = filter_type(cands, sheet)
    if teacher_college:
        hit = [c for c in cands if c.get('college') == teacher_college]
        if hit: cands = hit
    # “消费者行为学”和“消费者行为学（英）”是两门课，没有“英”就不要自动落到英文班
    if raw and '英' not in raw:
        hit = [c for c in cands if '（英）' not in c.get('name', '') and '(英)' not in c.get('name', '')]
        if hit: cands = hit
    return cands

def matched_or_ambiguous(cands):
    if len(cands) == 1:
        return {'status': 'matched', 'course': cands[0], 'candidates': cands}
    if len(cands) > 1:
        return {'status': 'ambiguous', 'course': None, 'candidates': cands}
    return None

def match_course(raw, sheet, teacher_college=''):
    raw = txt(raw)
    n = norm_name(raw)
    if not n:
        if sheet in ('形策', '行策'):
            raw = '形策'; n = '形策'
        else:
            return {'status': 'unmatched', 'course': None, 'candidates': []}
    # exact official name
    r = matched_or_ambiguous(refine_courses(BY_NAME.get(raw, []), sheet, teacher_college, raw))
    if r: return r
    # normalized exact
    r = matched_or_ambiguous(refine_courses(BY_NORM.get(n, []), sheet, teacher_college, raw))
    if r: return r
    # explicit aliases
    if n in ALIASES:
        cands = []
        for name in ALIASES[n]:
            cands += BY_NORM.get(norm_name(name), [])
        r = matched_or_ambiguous(refine_courses(cands, sheet, teacher_college, raw))
        if r: return r
    # 初级/中级/高级 xx → 已存在的 xx（例如 初级网球→网球、中级乒乓球→乒乓球）
    m = re.match(r'^(初级|中级|高级)(.+)$', n)
    if m:
        base = m.group(2)
        r = matched_or_ambiguous(refine_courses(BY_NORM.get(base, []), sheet, teacher_college, raw))
        if r: return r
    # 只做模糊候选展示，不自动挂课：差一个字的课名必须交给人确认
    pool = filter_type(COURSES, sheet)
    scored = []
    for c in pool:
        ratio = SequenceMatcher(None, n, norm_name(c['name'])).ratio()
        if ratio >= 0.82:
            scored.append((ratio, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    if scored:
        return {'status': 'ambiguous', 'course': None,
                'candidates': [c for _, c in scored[:8]], 'fuzzy': True}
    return {'status': 'unmatched', 'course': None, 'candidates': []}

def clean_teacher(raw):
    s = txt(raw)
    s = re.sub(r'(老师|教师|教授|副教授|讲师|博士|硕士)$', '', s).strip()
    s = re.sub(r'[（(].*?[)）]', '', s).strip()
    return s

def match_teacher(raw):
    s = clean_teacher(raw)
    if not s:
        return {'status': 'empty', 'name': '', 'hits': []}
    # 一行多个老师时先不对应到具体人名，交给待确认清单
    if re.search(r'[\s、,，/]+', s):
        parts = [x for x in re.split(r'[\s、,，/]+', s) if x]
        if len(parts) > 1:
            return {'status': 'multi', 'name': s, 'hits': []}
    n = norm_name(s)
    hits = TEACHERS.get(n, [])
    if len(hits) == 1:
        return {'status': 'matched', 'name': s, 'hits': hits}
    if len(hits) > 1:
        return {'status': 'ambiguous', 'name': s, 'hits': hits}
    return {'status': 'unmatched', 'name': s, 'hits': []}

PRIVACY = [
    (re.compile(r'1[3-9]\d{9}'), '手机号'),
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), '邮箱'),
    (re.compile(r'(微信|wechat|vx|v信|QQ|qq|群号|群聊)\s*[:：]?\s*[A-Za-z0-9_-]{5,}', re.I), '联系方式'),
    (re.compile(r'https?://\S+', re.I), '链接'),
]
PROFANITY = re.compile(r'(cnm|nmsl|傻逼|煞笔|脑残|废物|去死|滚蛋|操你|草你)', re.I)
STRONG_NEG = re.compile(r'(巨雷|大坑|狗都不选|千万别选|别选别选|看见.{0,12}别选)', re.I)
SOFTEN = [
    (r'别选别选别选', '不推荐'),
    (r'狗都不选', '不推荐'),
    (r'看见([^，。；]{1,10})就别选了', r'不建议选\1的课'),
    (r'千万别选', '不建议选'),
    (r'别选了', '不建议选'),
    (r'别选', '不建议选'),
    (r'巨雷', '评价较低'),
    (r'大坑', '不太推荐'),
    (r'cnm', ''),
    (r'纯傻逼', ''),
]

def sanitize(s, warnings):
    out = s
    for rx, label in PRIVACY:
        if rx.search(out):
            warnings.add('隐私:' + label + '已隐藏')
            out = rx.sub('[' + label + '已隐藏]', out)
    if STRONG_NEG.search(out):
        warnings.add('强负面表达已弱化')
    for pat, rep in SOFTEN:
        out = re.sub(pat, rep, out, flags=re.I)
    if PROFANITY.search(out):
        warnings.add('侮辱性表达已删除')
        out = PROFANITY.sub('', out)
    out = re.sub(r'\s{2,}', ' ', out).strip(' ，,；;')
    return out

def add_candidate(rows, fn, sh, row_no, course_raw, teacher_raw, sentiment, content_raw, module=''):
    blocking = set()
    warnings = set()
    course_raw = txt(course_raw)
    teacher_raw = clean_teacher(teacher_raw)
    sentiment = txt(sentiment)
    content = scrub_content(content_raw)
    # 纯提问不是评价；如果同一行有“好/雷”，以好/雷作为正文
    if is_noise(content):
        content = ''
    if not content and sentiment in ('好', '雷'):
        content = sentiment
    if not content:
        return None
    if not course_raw and not teacher_raw:
        return None
    if not course_raw and sh in ('形策', '行策'):
        course_raw = '形策'
    # 明显是广告/引流文本，不是课程名
    if re.search(r'(qg:/|支fu宝|支付宝|加微信|扫码|搜suozhan)', course_raw, re.I):
        return None

    teacher_match = match_teacher(teacher_raw)
    teacher_college = ''
    if teacher_match['status'] == 'matched' and teacher_match.get('hits'):
        teacher_college = teacher_match['hits'][0].get('college', '')
    course_match = match_course(course_raw, sh, teacher_college)
    if not course_raw and teacher_raw:
        course_match = {'status': 'teacher_only', 'course': None, 'candidates': []}

    score = 4 if sentiment == '好' else (2 if sentiment == '雷' else 0)
    if len(content) > 1000:
        warnings.add('正文超过1000字，已截断')
        content = content[:997] + '...'
    content = sanitize(content, warnings)
    if not content or is_noise(content):
        return None

    # 好/雷与正文明显相反时，不把冲突分数写进均分，降级为“仅文字”
    if score > 0:
        pos = re.search(r'(给分高|分高|给分很好|给分好|很好|挺好|不错|推荐|有趣|轻松|收获大|内容充实|老师可|人很好|喜欢|不雷|不会雷|非常好)', content)
        neg = re.search(r'(无聊|太严|不近人情|不推荐|坑|很差|评价较低|给分低|低分|考试难|很难|太难|挂科|作业多|大作业|5000字|五千字|查重|不建议|不想选)', content)
        if (score >= 4 and neg and not pos) or (score <= 2 and pos and not neg):
            warnings.add('好雷与正文冲突，已转为未评分')
            score = 0

    if course_match['status'] not in ('matched', 'teacher_only'):
        blocking.add('课程待确认:' + course_match['status'])
    if teacher_match['status'] in ('ambiguous', 'multi'):
        blocking.add('老师待确认:' + teacher_match['status'])
    # 老师不在官方名录不是错误：照常导入，只是 teacherVerified=false，不显示官方勾

    # 老师分和课程分分开：只有正文明确评价老师，或整条只有“好/雷”时才记老师分。
    teacher_score = 0
    teacher_basis = ''
    if teacher_raw and score > 0:
        if content.strip() in ('好', '雷'):
            teacher_score = score
            teacher_basis = 'sentiment_only'
        elif re.search(r'(老师|教师|人)[^。；]{0,10}(很好|挺好|不错|负责|耐心|温柔|有意思|超级好|人美心善|非常好|很好|nice|和善)', content, re.I):
            teacher_score = 4
            teacher_basis = 'content_positive'
        elif re.search(r'(老师|教师|人)[^。；]{0,10}(太严|不近人情|很差|不负责|凶|恶心|评价较低|骂|不给分|卡分|别选|不建议|不推荐)', content, re.I):
            teacher_score = 2
            teacher_basis = 'content_negative'
        elif not course_raw:
            teacher_score = score
            teacher_basis = 'teacher_only'

    course = course_match.get('course')
    candidate = {
        'sourceFile': fn,
        'sourceSheet': sh,
        'sourceRow': row_no,
        'courseRaw': course_raw,
        'teacherRaw': teacher_raw,
        'sentimentRaw': sentiment,
        'contentRaw': txt(content_raw),
        'content': content,
        'score': score,
        'teacherScore': teacher_score,
        'teacherScoreBasis': teacher_basis,
        'courseId': course['id'] if course else '',
        'courseName': course['name'] if course else (course_raw if course_match['status'] != 'teacher_only' else ''),
        'courseCollege': course.get('college', '') if course else '',
        'teacher': teacher_raw,
        'teacherVerified': teacher_match['status'] == 'matched',
        'teacherHits': [{'name': h.get('name',''), 'college': h.get('college','')} for h in teacher_match.get('hits', [])],
        'courseMatch': course_match['status'],
        'teacherMatch': teacher_match['status'],
        'courseCandidates': [{'id': c.get('id'), 'name': c.get('name'), 'college': c.get('college','')} for c in course_match.get('candidates', [])[:8]],
        'needsReview': bool(blocking),
        'flags': sorted(blocking | warnings),
        'blockingFlags': sorted(blocking),
        'warnings': sorted(warnings),
        'module': module,
        'kind': 'scored' if score > 0 else 'unscored'
    }
    rows.append(candidate)
    return candidate

def parse_guide():
    fn = '浙小商选课指南.xlsx.xlsx'
    path = os.path.join(SRC, fn)
    xl = pd.ExcelFile(path)
    out = []
    for sh in xl.sheet_names:
        df = pd.read_excel(path, sheet_name=sh, header=None, dtype=object)
        for ri in range(len(df)):
            vals = [txt(v) for v in df.iloc[ri].tolist()]
            if not any(vals): continue
            # 跳过表头
            joined = '|'.join(vals[:4])
            if ri == 0 and ('课程名' in joined or '老师' in joined or '雷/好' in joined):
                continue
            if sh == '通识课':
                course, teacher, senti, module, content = vals[0], vals[1], vals[2], vals[3], vals[4] if len(vals) > 4 else ''
                add_candidate(out, fn, sh, ri + 1, course, teacher, senti, content, module)
            elif sh in ('体育课', '专业课', '大英', '近代史马原毛概'):
                course, teacher, senti, content = (vals + [''] * 4)[:4]
                add_candidate(out, fn, sh, ri + 1, course, teacher, senti, content)
            elif sh == '形策':
                course, teacher, senti = (vals + [''] * 3)[:3]
                rest = [v for v in vals[3:] if v]
                content = '；'.join(rest)
                add_candidate(out, fn, sh, ri + 1, course, teacher, senti, content)
    return out

def parse_recommend():
    fn = '选课推荐.xlsx'; path = os.path.join(SRC, fn)
    df = pd.read_excel(path, sheet_name='Sheet1', header=None, dtype=object)
    out = []
    for ri in range(1, len(df)):
        vals = [txt(v) for v in df.iloc[ri].tolist()]
        if not any(vals): continue
        course = vals[0] if len(vals) > 0 else ''
        teacher = vals[2] if len(vals) > 2 else ''
        content = '；'.join([v for v in [vals[4] if len(vals) > 4 else '', vals[5] if len(vals) > 5 else ''] if v])
        add_candidate(out, fn, 'Sheet1', ri + 1, course, teacher, '', content, vals[3] if len(vals) > 3 else '')
    return out

def parse_info(fn, sheet_name, header_row, course_col, teacher_col, attendance_col, exam_col):
    path = os.path.join(SRC, fn)
    df = pd.read_excel(path, sheet_name=sheet_name, header=None, dtype=object)
    out = []
    for ri in range(header_row, len(df)):
        vals = [txt(v) for v in df.iloc[ri].tolist()]
        if not any(vals): continue
        course = vals[course_col] if len(vals) > course_col else ''
        teacher = vals[teacher_col] if len(vals) > teacher_col else ''
        att = vals[attendance_col] if len(vals) > attendance_col else ''
        exam = vals[exam_col] if len(vals) > exam_col else ''
        parts = []
        if att: parts.append('点名方式：' + att)
        if exam: parts.append('考试方式：' + exam)
        content = '；'.join(parts)
        add_candidate(out, fn, sheet_name, ri + 1, course, teacher, '', content,
                      '点名/考试信息')
    return out

def teacher_info(name):
    hits = TEACHERS.get(norm_name(name), [])
    if len(hits) == 1:
        return 'matched', True, hits
    if len(hits) > 1:
        return 'ambiguous', False, hits
    return 'unmatched', False, hits

def resolve_multi_teachers(rows):
    """把 5 条“一行多位老师”拆成：1 条课程评价 + 每位老师 1 条只评老师的记录。
    只对这些明确的行做，不把同一套规则套到所有多老师课程上。"""
    # source row -> (main_teacher, [(additional_teacher, extra_teacher_score)], skip)
    plan = {
        ('浙小商选课指南.xlsx.xlsx','通识课',8): ('厉小军', [('陈缘', 0)], False),
        ('浙小商选课指南.xlsx.xlsx','通识课',13): ('陈忠秀', [('秦玉梅', 0)], False),
        ('浙小商选课指南.xlsx.xlsx','通识课',63): ('胡玉可', [('李娟', 0)], False),
        ('浙小商选课指南.xlsx.xlsx','通识课',128): ('王琳', [('邢葳葳', 4)], False),
        ('浙小商选课指南.xlsx.xlsx','近代史马原毛概',9): ('王绪琴', [('黄娟', 0)], False),
        ('浙小商选课指南.xlsx.xlsx','通识课',131): ('', [], True),
    }
    out = []
    for r in rows:
        key = (r['sourceFile'], r['sourceSheet'], r['sourceRow'])
        if r.get('teacherMatch') != 'multi' or key not in plan:
            out.append(r)
            continue
        main_name, extras, skip = plan[key]
        if skip:
            continue
        r = dict(r)
        old_raw = r.get('teacherRaw', '')
        st, verified, hits = teacher_info(main_name)
        r['teacher'] = main_name
        r['teacherRaw'] = old_raw
        r['teacherMatch'] = st
        r['teacherVerified'] = verified
        r['teacherHits'] = [{'name': h.get('name',''), 'college': h.get('college','')} for h in hits]
        r['blockingFlags'] = [x for x in r.get('blockingFlags', []) if not x.startswith('老师待确认:')]
        r['flags'] = sorted(set(r.get('flags', [])) - {'老师待确认:multi'} | set(r['blockingFlags']))
        r['needsReview'] = bool(r['blockingFlags'])
        out.append(r)
        for idx, (name, extra_ts) in enumerate(extras, 2):
            e = dict(r)
            st2, verified2, hits2 = teacher_info(name)
            e['teacher'] = name
            e['teacherRaw'] = name
            e['teacherMatch'] = st2
            e['teacherVerified'] = verified2
            e['teacherHits'] = [{'name': h.get('name',''), 'college': h.get('college','')} for h in hits2]
            e['courseId'] = ''
            e['courseName'] = ''
            e['courseCollege'] = ''
            e['courseMatch'] = 'teacher_only'
            e['courseCandidates'] = []
            e['score'] = 0
            e['teacherScore'] = extra_ts
            e['teacherScoreBasis'] = 'multi_teacher_extra' if extra_ts else ''
            e['kind'] = 'unscored'
            e['variant'] = 'teacher%d' % idx
            e['blockingFlags'] = []
            e['needsReview'] = False
            e['flags'] = sorted(set(e.get('warnings', [])))
            out.append(e)
    return out

def parse_all():
    out = []
    out += parse_guide()
    out += parse_recommend()
    out += parse_info('浙小商通识课总表.xls', 'SQL Statement', 2, 1, 2, 3, 4)
    out += parse_info('浙小商通识课避雷针.xls', 'SQL Statement', 2, 1, 2, 3, 4)
    out += parse_info('通识课小纸条.xls', 'Sheet1', 2, 0, 1, 2, 3)
    out += parse_info('通识课小纸条.xls', 'Sheet2', 0, 0, 1, 2, 3)
    return resolve_multi_teachers(out)

def summarize(rows):
    summary = {'total': len(rows)}
    def cnt(key):
        d = {}
        for r in rows: d[r.get(key,'')] = d.get(r.get(key,''),0)+1
        return d
    summary['byFile'] = cnt('sourceFile')
    summary['bySheet'] = cnt('sourceSheet')
    summary['scored'] = sum(1 for r in rows if r['score'] > 0)
    summary['unscored'] = sum(1 for r in rows if r['score'] == 0)
    summary['needsReview'] = sum(1 for r in rows if r['needsReview'])
    summary['courseStatus'] = cnt('courseMatch')
    summary['teacherStatus'] = cnt('teacherMatch')
    summary['scoredByFile'] = {}
    for r in rows:
        if r['score'] > 0:
            summary['scoredByFile'][r['sourceFile']] = summary['scoredByFile'].get(r['sourceFile'],0)+1
    summary['unscoredByFile'] = {}
    for r in rows:
        if r['score'] == 0:
            summary['unscoredByFile'][r['sourceFile']] = summary['unscoredByFile'].get(r['sourceFile'],0)+1
    # 未匹配课程、老师的高频词
    unresolved_courses = {}
    unresolved_teachers = {}
    for r in rows:
        # 这里只列真正会阻断导入的项；老师不在名录、teacher_only 不再算待确认
        if r.get('needsReview') and r['courseMatch'] in ('unmatched','ambiguous'):
            k = r['courseRaw'] or '(空)'
            unresolved_courses[k] = unresolved_courses.get(k,0)+1
        if r.get('needsReview') and r['teacherMatch'] in ('ambiguous','multi'):
            k = r['teacherRaw'] or '(空)'
            unresolved_teachers[k] = unresolved_teachers.get(k,0)+1
    summary['unresolvedCourses'] = sorted(unresolved_courses.items(), key=lambda x:x[1], reverse=True)
    summary['unresolvedTeachers'] = sorted(unresolved_teachers.items(), key=lambda x:x[1], reverse=True)
    return summary

def write_csv(path, rows, fields):
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k,'') for k in fields})

def write_pending_outputs(rows, summary):
    need = [r for r in rows if r['needsReview']]
    ready = [r for r in rows if not r['needsReview']]
    with open(os.path.join(DATA, 'ready.json'), 'w', encoding='utf-8') as f:
        json.dump(ready, f, ensure_ascii=False, indent=2)
    fields = ['sourceFile','sourceSheet','sourceRow','courseRaw','courseMatch','courseName',
              'teacherRaw','teacherMatch','sentimentRaw','score','teacherScore','content',
              'flags','courseCandidates','teacherHits','contentRaw']
    with open(os.path.join(DATA, 'pending-review.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in need:
            out = {k: r.get(k, '') for k in fields}
            out['courseCandidates'] = ' | '.join(
                (c.get('id', '') + ':' + c.get('name', '')) for c in r.get('courseCandidates', []))
            out['teacherHits'] = ' | '.join(
                (c.get('name', '') + ':' + c.get('college', '')) for c in r.get('teacherHits', []))
            out['flags'] = '；'.join(r.get('flags', []))
            w.writerow(out)
    lines = ['# 课程评价导入待确认清单', '', '## 数量', '',
             '- 候选总数：%d' % len(rows),
             '- 可直接导入：%d' % len(ready),
             '- 待确认：%d' % len(need),
             '- 有评分：%d' % summary['scored'],
             '- 仅文字/课程信息：%d' % summary['unscored'], '', '## 课程匹配', '']
    for k, v in summary['courseStatus'].items():
        lines.append('- %s：%d' % ({'matched':'已匹配','unmatched':'未匹配','ambiguous':'有歧义'}.get(k,k), v))
    lines += ['', '### 高频待确认课程', '']
    for name, c in summary['unresolvedCourses'][:30]:
        lines.append('- %s：%d 条' % (name, c))
    lines += ['', '## 老师匹配', '']
    for k, v in summary['teacherStatus'].items():
        lines.append('- %s：%d' % ({'matched':'已匹配','unmatched':'名录未命中','ambiguous':'重名有歧义','empty':'未填老师','multi':'一行多位老师'}.get(k,k), v))
    lines += ['', '### 高频待确认老师', '']
    for name, c in summary['unresolvedTeachers'][:30]:
        lines.append('- %s：%d 条' % (name, c))
    lines += ['', '## 文件', '', '- `pending-review.csv`：逐条待确认清单（可用 Excel 打开）',
              '- `ready.json`：可直接导入的候选', '- `candidates.json`：全部结构化候选',
              '- `report.json`：机器可读统计', '- `trial.json`：小批量试导入样本',
              '- `rollback-*.json`：导入批次回滚 ID 清单', '']
    open(os.path.join(DATA, 'pending-summary.md'), 'w', encoding='utf-8').write('\n'.join(lines))

def main():
    rows = parse_all()
    # skip rows with no course/teacher/content already handled
    summary = summarize(rows)
    with open(os.path.join(DATA, 'candidates.json'), 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DATA, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    need = [r for r in rows if r['needsReview']]
    ready = [r for r in rows if not r['needsReview']]
    write_csv(os.path.join(DATA, 'needs-review.csv'), need,
              ['sourceFile','sourceSheet','sourceRow','courseRaw','teacherRaw','sentimentRaw','score','content','courseMatch','teacherMatch','flags','courseCandidates'])
    write_csv(os.path.join(DATA, 'ready.csv'), ready,
              ['sourceFile','sourceSheet','sourceRow','courseRaw','teacherRaw','sentimentRaw','score','content','courseId','courseName','teacher','teacherVerified'])
    write_pending_outputs(rows, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print('\nSAMPLE READY:')
    for r in ready[:12]:
        print(r['sourceFile'], r['sourceSheet'], r['sourceRow'], '|', r['courseRaw'], '->', r['courseName'], '|', r['teacherRaw'],
              '| score', r['score'], '|', r['content'][:80])
    print('\nSAMPLE NEED REVIEW:')
    for r in need[:12]:
        print(r['sourceFile'], r['sourceSheet'], r['sourceRow'], '|', r['courseRaw'], '|', r['teacherRaw'], '|', r['flags'], '|', r['content'][:60])

if __name__ == '__main__':
    main()
