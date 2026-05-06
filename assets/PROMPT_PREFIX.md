# 故宫像素风 — 通用规范

## 基础像素网格
- 以 16×16 为基本单位，@2× 即 32×32，@3× 即 48×48
- 统一用 PNG（不再用 SVG），透明背景

## 渲染要求
- 像素完美 / pixel-perfect
- 不允许抗锯齿（no anti-aliasing）
- 不允许半透明渐变（dithering 抖动可以）
- 边缘必须落在整数像素上

## 统一调色板（16 色）

| # | HEX | 名称 | 用途 |
|---|-----|------|------|
| 01 | #1A1612 | ink_deep | 最深线条 |
| 02 | #2A2622 | ink | 主线条色 |
| 03 | #5A5048 | ink_soft | 次要线条/阴影 |
| 04 | #6B6058 | muted | 灰褐，弱化文字/边框 |
| 05 | #F5EFE0 | paper | 主背景米色 |
| 06 | #EBE3D0 | paper_dim | 次级米色/阴影 |
| 07 | #FBF7E8 | paper_hi | 最亮高光 |
| 08 | #7A1F1F | seal_dark | 深印章红/阴影 |
| 09 | #B53A3A | seal | 主印章红，激活态 |
| 10 | #D9776E | seal_hi | 印章高光 |
| 11 | #2D6B4F | jade_dark | |
| 12 | #3F8C6E | jade | 成功/在线，主绿 |
| 13 | #6FB39A | jade_hi | |
| 14 | #9C6925 | amber_dark | |
| 15 | #C68A3A | amber | 忙碌/警告，主金 |
| 16 | #E5B568 | amber_hi | |

## 交付目录总览

```
assets/
├── nav/        14 PNG（7 default + 7 active）
├── tools/      11 PNG
├── actions/    10 PNG
├── avatars/     6 PNG（3 base + 3 @2x）
├── brand/       2 PNG + favicon.ico + og-cover.png
├── empty/       4 PNG
└── textures/    2 PNG
```

总计：49 张 PNG + 1 个 ICO
