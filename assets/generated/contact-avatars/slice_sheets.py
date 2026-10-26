"""Cut the contact-avatar sheets (BRD-07) into a regular 3x3 grid.

The generated sheets are 1536x1024 nine-grids on a #00ff00 backdrop, but the
nine portraits are not laid out on exact thirds (shoulders cross the lines).
So: key out the green by how much greener than red/blue a pixel is, split the
sheet into three rows at the two widest all-transparent row gaps, split each
row into three at its two widest column gaps, crop every portrait to a square
around its own pixels only (neighbours masked out), and repack the nine into a
576x576 sheet of 192px cells. The manifest records each cell; ids follow the
prompt order, left to right, top row first (AV-01-1 .. AV-15-9).

Usage: python3 -I slice_sheets.py <originals-dir> <out-dir>
"""
import json
import os
import sys

import numpy as np
from PIL import Image

CELL = 192
PAD = 6
SHEETS = 15

THEMES = {
    1: 'engineering', 2: 'engineering', 3: 'design', 4: 'content', 5: 'product',
    6: 'court-civil', 7: 'court-military', 8: 'court-life', 9: 'court-modern',
    10: 'animals', 11: 'animals', 12: 'robots', 13: 'people', 14: 'people', 15: 'whimsy',
}
LABELS = {
    1: '架构师 代码审稿人 测试工程师 安全审计 前端工程师 后端工程师 运维与发布 数据工程师 移动端工程师',
    2: '机器学习研究员 算法专家 数据库专家 性能调优 开源维护者 技术文档 自动化测试 值班工程师 嵌入式工程师',
    3: '素材设计师 界面设计评审 插画师 动效设计师 品牌设计师 三维美术 摄影师 用户体验研究 字体设计师',
    4: '研究员 写作者 编辑 译者 市场文案 记者 播客主持 社媒运营 诗人',
    5: '产品经理 用户研究员 数据分析师 反方（红队） 主持人 战略顾问 项目经理 财务分析 合规顾问',
    6: '丞相 内阁学士 御史 翰林学士 女官 史官 钦天监 太医 户部尚书',
    7: '大将军 女将军 锦衣卫 御前侍卫 军师 斥候 弓箭手 老将 少年将军',
    8: '御厨 宫廷画师 乐师 舞者 园丁 茶艺师 书法家 棋手 说书人',
    9: '丞相·笔记本 将军·VR 女官·平板 太医·听诊器 锦衣卫·耳麦 史官·录音笔 钦天监·无人机 御厨·奶茶 翰林·耳机',
    10: '狸花猫 柴犬 熊猫 狐狸 仓鼠 猫头鹰 鹦鹉 兔子 水獭',
    11: '黑猫 金毛 浣熊 刺猬 小鹿 海豹 树懒 仙鹤 小龙',
    12: '复古机器人 白色机器人 无人机 冠天线机器人 机甲驾驶员 全息助手 蒸汽机械人 机器猫 屏幕脸机器人',
    13: '银发奶奶 爆炸头青年 长辫女士 小胡子大叔 戴头巾的女士 领结老先生 滑板青年 胶片相机女士 花衬衫大哥',
    14: '雀斑女士 束发青年 花头巾女士 包头巾的先生 卷发女士 戴助听器的先生 开衫老先生 贝雷帽女士 牙套青年',
    15: '舞狮 京剧 宇航员 侦探 巫师 海盗船长 农夫 潜水员 皮影师',
}
TINTS = ['#E8DEC8', '#D6E2EC', '#E0D8EC', '#ECDAD0', '#D6E8DC', '#F0E4C8']


def key(rgb):
    a = rgb.astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = g - np.maximum(r, b)
    alpha = np.clip((90 - d) * 255 / 60, 0, 255)
    g = np.where(d > 30, np.minimum(g, np.maximum(r, b) + 10), g)
    return np.dstack([r, g, b, alpha]).astype(np.uint8)


def runs(mask):
    out, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        if not v and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def split3(profile):
    """Three content bands separated by the two widest gaps."""
    r = [s for s in runs(profile > 2) if s[1] - s[0] >= 4]
    if len(r) < 3:
        raise ValueError('fewer than three content bands')
    gaps = sorted(((r[i + 1][0] - r[i][1], i) for i in range(len(r) - 1)), reverse=True)[:2]
    a, b = sorted(i for _, i in gaps)
    return [(r[0][0], r[a][1]), (r[a + 1][0], r[b][1]), (r[b + 1][0], r[-1][1])]


def cut(path):
    rgba = key(np.asarray(Image.open(path).convert('RGB')))
    solid = rgba[..., 3] > 60
    cells = []
    for y0, y1 in split3(solid.sum(axis=1)):
        for x0, x1 in split3(solid[y0:y1].sum(axis=0)):
            ys, xs = np.nonzero(solid[y0:y1, x0:x1])
            bx0, bx1, by0, by1 = x0 + xs.min(), x0 + xs.max(), y0 + ys.min(), y0 + ys.max()
            side = int(max(bx1 - bx0 + 1, by1 - by0 + 1) * 1.04)
            cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
            iso = rgba.copy()
            keep = np.zeros(solid.shape, bool)
            keep[y0:y1, x0:x1] = True
            iso[..., 3] = np.where(keep, iso[..., 3], 0)
            sx, sy = int(cx - side / 2), int(cy - side / 2)
            cells.append(Image.fromarray(iso).crop((sx, sy, sx + side, sy + side)))
    if len(cells) != 9:
        raise ValueError(f'{path}: {len(cells)} portraits, expected 9')
    return cells


def main(src, out):
    os.makedirs(out, exist_ok=True)
    manifest = []
    for n in range(1, SHEETS + 1):
        sid = f'AV-{n:02d}'
        cells = cut(os.path.join(src, f'{sid}.png'))
        sheet = Image.new('RGBA', (CELL * 3, CELL * 3), (0, 0, 0, 0))
        labels = LABELS[n].split(' ')
        for k, im in enumerate(cells):
            row, col = divmod(k, 3)
            # Premultiplied resize keeps the soft edges free of the green.
            small = im.convert('RGBa').resize((CELL - 2 * PAD, CELL - 2 * PAD), Image.LANCZOS).convert('RGBA')
            sheet.alpha_composite(small, (col * CELL + PAD, row * CELL + PAD))
            manifest.append({
                'id': f'{sid}-{k + 1}',
                'sheet': sid,
                'rect': [col * CELL, row * CELL, CELL, CELL],
                'theme': THEMES[n],
                'label': labels[k],
                'tint': TINTS[(n + k + 1) % len(TINTS)],
            })
        sheet.save(os.path.join(out, f'{sid}.webp'), 'WEBP', quality=82, alpha_quality=90, method=6)
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
