#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tabBar 图标几何归一化：把 5 个图标 × 常态/选中 的墨迹收到同一画心并居中。

为什么需要这个：tabBar 的图标是 png，微信**不会**按内容自动对齐 —— 它把每张图
按 81×81 的画布整张贴上去。所以只要墨迹在画布里的位置和大小不同，切 tab 时就会
看到图标「忽大忽小、忽上忽下」。实测（2026-10-17）：

    campus 65×63  重心 y=46.2   ← 最大的一个，且明显偏下
    course 61×60  重心 y=37.3
    forum  62×62  重心 y=37.3
    market 62×56  重心 y=36.2
    mine   55×58  重心 y=43.0   ← 最小的一个

纵向差 9px（约 14%），重心差 10px —— 在 27pt 的显示尺寸上肉眼就能看出来。

做法：按 alpha 的包围盒等比缩放到统一的 TARGET 边长，再把包围盒中心挪到画布中心。
缩放走**预乘 alpha + 双线性**，避免边缘混进透明像素的颜色发黑/发白。

用法：
    python scripts/normalize-tabbar-icons.py            # 只检查（CI 用），有偏差就退出码 1
    python scripts/normalize-tabbar-icons.py --fix      # 就地重写 png
    python scripts/normalize-tabbar-icons.py --fix --dry-run   # 只打印打算怎么改

幂等：缩放比在 1±0.02 且中心偏移 <1px 的图标直接跳过不写，
所以反复跑不会一次次重采样把图标越磨越糊。
"""

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.path.dirname(HERE), 'miniprogram', 'zjgsu-campus')
TABBAR = os.path.join(ROOT, 'assets', 'tabbar')

CANVAS = 81          # 3x 下的标准画布（tabBar 图标显示 27pt）
TARGET = 62          # 墨迹最大边，约画布 76%
ALPHA_INK = 24       # 判定「这里有墨」的 alpha 下限，和 check-tabbar-icons.py 对齐
SIZE_TOL = 1.5       # 允许的尺寸偏差（像素）
POS_TOL = 1.2        # 允许的中心偏移（像素）
NOOP_SCALE = 0.02    # 缩放比落在这个区间就认为不需要重采样（幂等保护）

BPP_OF_CT = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def decode_png(path):
    """解成 (w, h, ct, rows)，rows 是每行的原始字节。只支持非隔行 8bit。"""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('不是 PNG：' + path)
    pos, idat, ihdr = 8, b'', None
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', chunk)
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
        pos += 12 + ln
    w, h, depth, ct, _comp, _filt, inter = ihdr
    if inter:
        raise ValueError('隔行扫描不支持：' + path)
    if depth != 8:
        raise ValueError('只处理 8bit：' + path)
    raw = zlib.decompress(idat)
    bpp = BPP_OF_CT[ct]
    stride = w * bpp
    rows = []
    prev = bytearray(stride)
    p = 0
    for _y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, ct, rows


def to_rgba(w, h, ct, rows):
    """统一成 ((r,g,b,a) 列表按行铺平) —— 只处理灰度/RGB/RGBA 三种常见组合"""
    out = []
    if ct == 6:
        for row in rows:
            for x in range(w):
                o = x * 4
                out.append((row[o], row[o + 1], row[o + 2], row[o + 3]))
    elif ct == 2:
        for row in rows:
            for x in range(w):
                o = x * 3
                out.append((row[o], row[o + 1], row[o + 2], 255))
    elif ct == 0:
        for row in rows:
            for x in range(w):
                v = row[x]
                out.append((v, v, v, 255))
    else:
        raise ValueError('不支持的 color type：%d' % ct)
    return out


def ink_bbox(px, w, h):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        base = y * w
        for x in range(w):
            if px[base + x][3] >= ALPHA_INK:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    if x1 < 0:
        return None
    return x0, y0, x1, y1


def normalize(px, w, h, target=TARGET):
    """把墨迹等比缩到 target 边长、包围盒中心对准画布中心，返回新的 RGBA 像素列表"""
    box = ink_bbox(px, w, h)
    if not box:
        return px, 1.0, (0.0, 0.0)
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    scale = float(target) / max(bw, bh)
    # 目标画布里，墨迹该占多大、从哪开始
    tw, th = bw * scale, bh * scale
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    ox = cx - (x0 + (bw - 1) / 2.0) * scale   # 目标坐标 = 源坐标*scale + o
    oy = cy - (y0 + (bh - 1) / 2.0) * scale

    # 预乘：透明像素的 rgb 不可信，直接插值会在边缘留下暗边
    pre = []
    for (r, g, b, a) in px:
        af = a / 255.0
        pre.append((r * af, g * af, b * af, a))

    out = [None] * (w * h)
    for ty in range(h):
        sy = (ty - oy) / scale
        y0i = int(sy)
        fy = sy - y0i
        for tx in range(w):
            sx = (tx - ox) / scale
            x0i = int(sx)
            fx = sx - x0i
            acc = [0.0, 0.0, 0.0, 0.0]
            for dy in (0, 1):
                yy = y0i + dy
                if yy < 0 or yy >= h:
                    continue
                wy = fy if dy else 1.0 - fy
                row = yy * w
                for dx in (0, 1):
                    xx = x0i + dx
                    if xx < 0 or xx >= w:
                        continue
                    wgt = wy * (fx if dx else 1.0 - fx)
                    if wgt <= 0:
                        continue
                    p = pre[row + xx]
                    acc[0] += p[0] * wgt
                    acc[1] += p[1] * wgt
                    acc[2] += p[2] * wgt
                    acc[3] += p[3] * wgt
            a = acc[3]
            if a <= 0.5:
                out[ty * w + tx] = (0, 0, 0, 0)
            else:
                af = a / 255.0
                out[ty * w + tx] = (
                    int(round(acc[0] / af)), int(round(acc[1] / af)),
                    int(round(acc[2] / af)), int(round(a))
                )
    return out, scale, (ox, oy)


def encode_png(w, h, px, path):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b, a = px[y * w + x]
            raw += bytes((r, g, b, a))
    idat = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    blob = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', idat) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(blob)


def main(argv):
    fix = '--fix' in argv
    dry = '--dry-run' in argv
    if not os.path.isdir(TABBAR):
        print('找不到 ' + TABBAR)
        return 2

    names = sorted(n for n in os.listdir(TABBAR) if n.endswith('.png'))
    if not names:
        print('assets/tabbar 下没有 png')
        return 2

    print('画布 %d × %d，墨迹目标 %d × %d，容差 ±%.1fpx / 中心 ±%.1fpx'
          % (CANVAS, CANVAS, TARGET, TARGET, SIZE_TOL, POS_TOL))
    print()
    print('%-18s %-11s %-15s %s' % ('图标', '墨迹', '缩放', '处理'))
    print('-' * 74)
    bad = []
    changed = 0
    for name in names:
        path = os.path.join(TABBAR, name)
        w, h, ct, rows = decode_png(path)
        px = to_rgba(w, h, ct, rows)
        box = ink_bbox(px, w, h)
        if not box:
            print('%-18s 空图，跳过' % name)
            bad.append(name)
            continue
        x0, y0, x1, y1 = box
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        ccx, ccy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        dx, dy = ccx - (w - 1) / 2.0, ccy - (h - 1) / 2.0
        off_size = abs(max(bw, bh) - TARGET)
        off_pos = max(abs(dx), abs(dy))
        need = off_size > SIZE_TOL or off_pos > POS_TOL

        if not need:
            print('%-18s %2d×%-2d      —              已对齐' % (name, bw, bh))
            continue

        if w != CANVAS or h != CANVAS:
            print('%-18s %2d×%-2d      画布不是 %d，先修画布' % (name, bw, bh, CANVAS))
            bad.append(name)
            continue

        new_px, scale, _ = normalize(px, w, h)
        # 幂等保护：已经足够接近的文件不重采样，免得反复跑越磨越糊
        if abs(scale - 1.0) < NOOP_SCALE and off_pos <= POS_TOL:
            print('%-18s %2d×%-2d      %.2f            无需重采样' % (name, bw, bh, scale))
            continue

        action = '缩放 %.2fx，中心挪 (%+.0f,%+.0f)' % (scale, -dx, -dy)
        if fix and not dry:
            encode_png(w, h, new_px, path)
            changed += 1
            print('%-18s %2d×%-2d      %.2f            ✓ %s' % (name, bw, bh, scale, action))
        else:
            print('%-18s %2d×%-2d      %.2f            %s%s' % (
                name, bw, bh, scale, action, '（dry-run）' if dry else '（待修，加 --fix）'))
        bad.append(name)

    print()
    if bad and not fix:
        print('有 %d 个图标的墨迹没有对齐：%s' % (len(bad), '、'.join(bad)))
        print('跑 python scripts/normalize-tabbar-icons.py --fix 修正')
        return 1
    if fix:
        print('已重写 %d 个文件' % changed)
        return 0
    print('全部图标墨迹尺寸与画心一致')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
