#!/usr/bin/env python3
"""
deringing_bridge.py —— CEP 面板桥接：把 deringing_v9_ycrcb 的联合通道修复包成
与面板兼容的 CLI / status JSON 接口。

用法: py -3.11 deringing_bridge.py <输入.png> <输出.png> [--status=F] [--report=F] [--quiet]
面板传来的 --far/--keep/--ramp/--strength/--negate 接受但忽略（v9 全自动，无这些参数）。
读写使用 imdecode/imencode，避免 OpenCV 在 Windows 下无法读取中文路径。
依赖: numpy, opencv-python, numba
"""
import argparse
import json
import os
import sys
import time

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.dirname(_HERE)
for _p in (_HERE, _PARENT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from deringing_v9_ycrcb import repair_image_joint


def imread_u(path):
    data = np.fromfile(path, dtype=np.uint8)
    bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError('无法读取输入图片: ' + path)
    return bgr


def imwrite_u(path, bgr):
    ok, buf = cv2.imencode('.png', bgr)
    if not ok:
        raise IOError('PNG 编码失败')
    buf.tofile(path)


def estimate_ink_polarity(bgr):
    """快速估算前景极性（浅底深字 vs 深底浅字）与墨迹占比，仅用于面板日志展示。"""
    y8 = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)[:, :, 0]
    thr, _ = cv2.threshold(y8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark_ratio = float(np.mean(y8 <= thr))
    ink_is_dark = dark_ratio <= 0.5
    ink_ratio = dark_ratio if ink_is_dark else (1.0 - dark_ratio)
    return int(thr), bool(ink_is_dark), round(100.0 * ink_ratio, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--status')
    ap.add_argument('--report')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--far', type=float, default=22)
    ap.add_argument('--keep', type=float, default=0)
    ap.add_argument('--ramp', type=float, default=0)
    ap.add_argument('--strength', type=float, default=1)
    ap.add_argument('--negate', action='store_true')
    args = ap.parse_args()

    t0 = time.time()
    bgr = imread_u(args.input)
    out, v9_report, _ = repair_image_joint(bgr)
    ms = int((time.time() - t0) * 1000)
    imwrite_u(args.output, out)

    h, w = bgr.shape[:2]
    thr, ink_is_dark, ink_ratio = estimate_ink_polarity(bgr)
    diff = np.abs(out.astype(np.int16) - bgr.astype(np.int16)).max(axis=2)
    changed = int((diff >= 1).sum())

    report = {
        'algorithm': v9_report.get('algorithm', 'v9-anisotropic-local-linear-joint-ycrcb'),
        'input': args.input,
        'output': args.output,
        'ms': ms,
        'size': f'{w}x{h}',
        'threshold': thr,
        'inkIsDark': ink_is_dark,
        'inkRatio': ink_ratio,
        'processed': True,
        'warnings': [],
        'avgDelta': round(float(diff[diff >= 1].mean()) if changed else 0.0, 2),
        'maxDelta': int(diff.max()),
        'changedPct': round(100.0 * changed / (w * h), 2),
    }
    if args.report:
        with open(args.report, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    if args.status:
        with open(args.status, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False)
    if not args.quiet:
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
