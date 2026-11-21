# -*- coding: utf-8 -*-
"""检查 tabBar 图标在深色背景上还看不看得见。

微信小程序的 tabBar 图标是 png，theme.json 只能配文字和背景色，
**配不了图标**——切到深色时图标不会有任何变化。
所以图标本身必须是「深浅底上都看得见」的中间调：
太深（接近 #000）会在深色底上消失，太浅（接近 #fff）会在浅色底上消失。
"""
import os
import re
import struct
import sys
import zlib

_HERE = os.path.dirname(os.path.abspath(__file__))          # recon/scripts
ROOT = os.path.join(os.path.dirname(_HERE), 'miniprogram', 'zjgsu-campus')
TABBAR = os.path.join(ROOT, 'assets', 'tabbar')

BPP = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def decode_png(path):
    d = open(path, 'rb').read()
    if d[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('不是 PNG: ' + path)
    pos, idat, meta = 8, b'', None
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        data = d[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            meta = struct.unpack('>IIBBBBB', data)
        elif typ == b'IDAT':
            idat += data
        elif typ == b'IEND':
            break
        pos += 12 + ln
    w, h, _bd, ct, _c, _f, inter = meta
    if inter:
        raise ValueError('隔行扫描的 PNG 不支持: ' + path)
    raw = zlib.decompress(idat)
    bpp = BPP[ct]
    stride = w * bpp
    prev = bytearray(stride)
    rows = []
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
    return w, h, ct, bpp, rows


def lum(r, g, b):
    """感知亮度（0-255）"""
    return 0.299 * r + 0.587 * g + 0.114 * b


def main():
    if not os.path.isdir(TABBAR):
        print('找不到 ' + TABBAR)
        return 1
    print('%-22s %-10s %-10s %s' % ('图标', '平均亮度', '可见像素', '结论'))
    print('-' * 66)
    bad = []
    for name in sorted(os.listdir(TABBAR)):
        if not name.endswith('.png'):
            continue
        w, h, ct, bpp, rows = decode_png(os.path.join(TABBAR, name))
        tot_l, n, opaque = 0.0, 0, 0
        for r_i, row in enumerate(rows):
            for x in range(w):
                o = x * bpp
                if ct == 6:
                    a = row[o + 3]
                    if a < 40:
                        continue
                    r, g, b = row[o], row[o + 1], row[o + 2]
                elif ct == 2:
                    r, g, b, a = row[o], row[o + 1], row[o + 2], 255
                else:
                    continue
                opaque += 1
                tot_l += lum(r, g, b)
                n += 1
        avg = tot_l / n if n else 0
        # 深色底 #161b22 的亮度约 26；浅色底 #ffffff 是 255
        # 图标亮度落在 60~200 之间，两边都还有对比度
        verdict = 'OK'
        if avg < 60:
            verdict = '偏暗，深色底上会糊'
            bad.append(name)
        elif avg > 200:
            verdict = '偏亮，浅色底上会糊'
            bad.append(name)
        print('%-22s %-10.1f %-10d %s' % (name, avg, opaque, verdict))
    print()
    if bad:
        print('需要处理的图标：')
        for b in bad:
            print('  ' + b)
        return 1
    print('全部图标在深浅两种底色下都还有对比度')
    return 0


if __name__ == '__main__':
    sys.exit(main())
