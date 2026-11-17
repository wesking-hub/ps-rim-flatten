#!/usr/bin/env python3
"""v9：基于联合 Y/Cr/Cb 结构场与异方性局部平面回归的全分辨率去振铃/平坦化算法。

直接从原图估计干净的 (Y, Cr, Cb) 场，不依赖 v7/v8，无文字二值掩码或原图硬回填。
核心机制：
  1. 双角色连续结构场：利用 3x3 邻域次序统计量 d_(3)、d_(4) 与双向斜坡检测，
     在不膨胀边缘死区（距边缘 2px 的波纹区仍保持高基底度）的前提下，
     将平坦基底像素与 1px 细线、抗锯齿过渡像素连续分离。
  2. 异方性局部一阶平面回归：在平坦基底上拟合带凸包钳位的局部线性平面，
     无偏保持色块/背景的自然渐变斜率，同时跨过白字阻挡消除中尺度凹凸与贴边振铃；
     在强结构界面处通过高阶斜率正则与法向投影衰减连续退化为保边估计。
"""
import argparse
import json
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np
from numba import njit, prange

_MATRIX = np.array([[0.114, 0.587, 0.299],
                    [-0.713 * 0.114, -0.713 * 0.587, 0.713 * (1.0 - 0.299)],
                    [0.564 * (1.0 - 0.114), -0.564 * 0.587, -0.564 * 0.299]], dtype=np.float32)
_INVERSE = np.linalg.inv(_MATRIX).astype(np.float32)
_OFFSET = np.array([0.0, 128.0, 128.0], dtype=np.float32)


def read_image(path):
    image = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f'无法解码图像：{path}')
    return image


def write_image(path, image):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buffer = cv2.imencode('.png', image)
    if not ok:
        raise IOError('PNG 编码失败')
    buffer.tofile(str(path))


def to_ycrcb(bgr):
    return bgr.astype(np.float32) @ _MATRIX.T + _OFFSET


def from_ycrcb(channels):
    return (channels - _OFFSET) @ _INVERSE.T


@njit(parallel=True, cache=False)
def compute_dual_structure_field(src):
    """计算目标平滑度 phi_target 与样本纯净度 phi_sample（连续值域 [0, 1]）。"""
    H, W, _ = src.shape
    phi_target = np.empty((H, W), np.float32)
    phi_sample = np.empty((H, W), np.float32)
    iy2 = 1.0 / (3.2 * 3.2)
    ic2 = 1.0 / (4.8 * 4.8)
    for r in prange(H):
        for c in range(W):
            a0, a1, a2 = src[r, c, 0], src[r, c, 1], src[r, c, 2]
            ds = np.empty(8, np.float32)
            cnt = 0
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    rr = min(max(r + dr, 0), H - 1)
                    cc = min(max(c + dc, 0), W - 1)
                    d2 = ((src[rr, cc, 0] - a0) ** 2 * iy2 +
                          (src[rr, cc, 1] - a1) ** 2 * ic2 +
                          (src[rr, cc, 2] - a2) ** 2 * ic2)
                    ds[cnt] = d2
                    cnt += 1
            for i in range(1, 8):
                key = ds[i]
                j = i - 1
                while j >= 0 and ds[j] > key:
                    ds[j + 1] = ds[j]
                    j -= 1
                ds[j + 1] = key

            r_t = ds[2] / (1.05 * 1.05)
            r_s = ds[3] / (2.10 * 2.10)

            ramp = 0.0
            for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
                r1, c1 = min(max(r + dr, 0), H - 1), min(max(c + dc, 0), W - 1)
                r2, c2 = min(max(r - dr, 0), H - 1), min(max(c - dc, 0), W - 1)
                for ch_i, sc in ((0, 2.5), (1, 4.5), (2, 4.5)):
                    ac = a0 if ch_i == 0 else (a1 if ch_i == 1 else a2)
                    v1 = src[r1, c1, ch_i] - ac
                    v2 = src[r2, c2, ch_i] - ac
                    if v1 * v2 < 0.0:
                        m_step = min(abs(v1), abs(v2)) / sc
                        if m_step > ramp:
                            ramp = m_step

            r_total = max(r_t, ramp * ramp)
            phi_target[r, c] = 1.0 / (1.0 + r_total * r_total * r_total)
            phi_sample[r, c] = (1.0 / (1.0 + r_s * r_s * r_s)) * (1.0 / (1.0 + (ramp * ramp) ** 2))
    return phi_target, phi_sample


@njit(parallel=True, cache=False)
def anisotropic_local_linear_step(cur, guide_orig, phi_target, phi_sample,
                                  nx_map, ny_map, coh_map, offsets, sp_weights,
                                  sigma_y, sigma_c):
    H, W, _ = cur.shape
    out = np.empty_like(cur)
    for r in prange(H):
        for col in range(W):
            pt = phi_target[r, col]
            a0, a1, a2 = cur[r, col, 0], cur[r, col, 1], cur[r, col, 2]
            if pt < 0.12:
                out[r, col, 0] = a0
                out[r, col, 1] = a1
                out[r, col, 2] = a2
                continue

            g0, g1, g2 = guide_orig[r, col, 0], guide_orig[r, col, 1], guide_orig[r, col, 2]
            scale = 0.02 + 0.98 * pt
            iy2 = 1.0 / ((sigma_y * scale) ** 2)
            ic2 = 1.0 / ((sigma_c * scale) ** 2)

            nx = nx_map[r, col]
            ny = ny_map[r, col]
            aniso = (1.0 - pt) * coh_map[r, col] * 2.0

            reg = 0.5 + 4000.0 * ((1.0 - pt) ** 3)
            s1 = 1.0
            sx = 0.0
            sy = 0.0
            sxx = reg
            sxy = 0.0
            syy = reg

            t1_0, t1_1, t1_2 = a0, a1, a2
            tx_0, tx_1, tx_2 = 0.0, 0.0, 0.0
            ty_0, ty_1, ty_2 = 0.0, 0.0, 0.0
            min0, max0 = a0, a0
            min1, max1 = a1, a1
            min2, max2 = a2, a2

            for k in range(len(offsets)):
                dy = offsets[k, 0]
                dx = offsets[k, 1]
                rr = r + dy
                cc = col + dx
                if rr < 0 or rr >= H or cc < 0 or cc >= W:
                    continue
                qs = phi_sample[rr, cc]
                if qs < 1e-3:
                    continue

                og0, og1, og2 = guide_orig[rr, cc, 0], guide_orig[rr, cc, 1], guide_orig[rr, cc, 2]
                d_orig = (og0 - g0) ** 2 * iy2 + (og1 - g1) ** 2 * ic2 + (og2 - g2) ** 2 * ic2
                if d_orig >= 6.25:
                    continue

                b0, b1, b2 = cur[rr, cc, 0], cur[rr, cc, 1], cur[rr, cc, 2]
                d_cur = (b0 - a0) ** 2 * iy2 + (b1 - a1) ** 2 * ic2 + (b2 - a2) ** 2 * ic2
                if d_cur >= 7.5:
                    continue

                proj_n = dx * nx + dy * ny
                w_aniso = np.exp(-0.5 * aniso * proj_n * proj_n)
                w = sp_weights[k] * qs * w_aniso * np.exp(-0.45 * d_cur)
                if w < 1e-5:
                    continue

                fdx = float(dx)
                fdy = float(dy)
                s1 += w
                sx += w * fdx
                sy += w * fdy
                sxx += w * fdx * fdx
                sxy += w * fdx * fdy
                syy += w * fdy * fdy

                t1_0 += w * b0; t1_1 += w * b1; t1_2 += w * b2
                tx_0 += w * fdx * b0; tx_1 += w * fdx * b1; tx_2 += w * fdx * b2
                ty_0 += w * fdy * b0; ty_1 += w * fdy * b1; ty_2 += w * fdy * b2

                if b0 < min0: min0 = b0
                if b0 > max0: max0 = b0
                if b1 < min1: min1 = b1
                if b1 > max1: max1 = b1
                if b2 < min2: min2 = b2
                if b2 > max2: max2 = b2

            m_xx = sxx * syy - sxy * sxy
            m_xy = sx * syy - sy * sxy
            m_xz = sx * sxy - sy * sxx
            det = s1 * m_xx - sx * m_xy + sy * m_xz
            if det > 1e-6:
                inv = 1.0 / det
                u0 = (t1_0 * m_xx - tx_0 * m_xy + ty_0 * m_xz) * inv
                u1 = (t1_1 * m_xx - tx_1 * m_xy + ty_1 * m_xz) * inv
                u2 = (t1_2 * m_xx - tx_2 * m_xy + ty_2 * m_xz) * inv
                out[r, col, 0] = min(max(u0, min0), max0)
                out[r, col, 1] = min(max(u1, min1), max1)
                out[r, col, 2] = min(max(u2, min2), max2)
            else:
                out[r, col, 0] = t1_0 / s1
                out[r, col, 1] = t1_1 / s1
                out[r, col, 2] = t1_2 / s1
    return out


def repair_image_joint(bgr, spatial=20.0, sigma_y=9.5, sigma_c=9.0):
    if bgr.dtype != np.uint8 or bgr.ndim != 3 or bgr.shape[2] != 3 or not bgr.size:
        raise ValueError('需要非空 uint8 BGR 图像')
    if not np.isfinite([spatial, sigma_y, sigma_c]).all() or not (0.5 <= spatial <= 64 and 0.25 <= sigma_y <= 64 and 0.25 <= sigma_c <= 64):
        raise ValueError('支持的空间尺度为 0.5–64，通道颜色带宽为 0.25–64')

    source = np.ascontiguousarray(to_ycrcb(bgr))
    phi_t, phi_s = compute_dual_structure_field(source)

    gx = cv2.Scharr(source, cv2.CV_32F, 1, 0) / 32.0
    gy = cv2.Scharr(source, cv2.CV_32F, 0, 1) / 32.0
    jxx = cv2.GaussianBlur(np.sum(gx * gx, axis=2), (0, 0), 1.2, borderType=cv2.BORDER_REFLECT_101)
    jxy = cv2.GaussianBlur(np.sum(gx * gy, axis=2), (0, 0), 1.2, borderType=cv2.BORDER_REFLECT_101)
    jyy = cv2.GaussianBlur(np.sum(gy * gy, axis=2), (0, 0), 1.2, borderType=cv2.BORDER_REFLECT_101)
    diff = jxx - jyy
    root = np.hypot(diff, 2.0 * jxy)
    lam1 = 0.5 * (jxx + jyy + root)
    lam2 = 0.5 * (jxx + jyy - root)
    angle = 0.5 * np.arctan2(2.0 * jxy, diff)
    nx = np.cos(angle).astype(np.float32)
    ny = np.sin(angle).astype(np.float32)
    coh = ((lam1 - lam2) / (lam1 + lam2 + 10.0)).astype(np.float32)

    radius = max(4, int(np.ceil(spatial * 1.4)))
    offsets = []
    spatial_weights = []
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx == 0 and dy == 0:
                continue
            r2 = dx * dx + dy * dy
            if r2 > radius * radius:
                continue
            if abs(dx) <= 6 and abs(dy) <= 6:
                mult = 1.0
            elif (dx % 2 == 0) and (dy % 2 == 0):
                mult = 4.0
            else:
                continue
            offsets.append((dy, dx))
            spatial_weights.append(mult * np.exp(-r2 / (2.0 * spatial * spatial)))

    off_arr = np.array(offsets, np.int32)
    sp_arr = np.array(spatial_weights, np.float32)

    est1 = anisotropic_local_linear_step(source, source, phi_t, phi_s, nx, ny, coh, off_arr, sp_arr, sigma_y, sigma_c)
    estimate = anisotropic_local_linear_step(est1, source, phi_t, phi_s, nx, ny, coh, off_arr, sp_arr, sigma_y, sigma_c)

    raw_bgr = from_ycrcb(estimate)
    result = np.clip(np.rint(raw_bgr), 0, 255).astype(np.uint8)
    delta = estimate - source
    report = {
        'algorithm': 'v9-anisotropic-local-linear-joint-ycrcb',
        'input_size': [int(bgr.shape[1]), int(bgr.shape[0])],
        'spatial': float(spatial),
        'kernel_radius': int(radius),
        'sigma_y': float(sigma_y),
        'sigma_cr_cb': float(sigma_c),
        'uses_v7_or_v8': False,
        'uses_spatial_downsampling': False,
        'uses_text_mask': False,
        'uses_final_original_pixel_replacement': False,
        'mean_absolute_Y_Cr_Cb_change': np.mean(np.abs(delta), axis=(0, 1)).round(4).tolist(),
        'changed_pixels': int(np.count_nonzero(np.any(result != bgr, axis=2))),
        'preclip_rgb_out_of_range_pixels': int(np.count_nonzero(np.any((raw_bgr < -0.05) | (raw_bgr > 255.05), axis=2))),
    }
    return result, report, {'source': source, 'estimate': estimate, 'phi_target': phi_t, 'phi_sample': phi_s}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--report')
    parser.add_argument('--spatial', type=float, default=20.0)
    parser.add_argument('--sigma-y', type=float, default=9.5)
    parser.add_argument('--sigma-c', type=float, default=9.0)
    args = parser.parse_args()
    start = perf_counter()
    result, report, _ = repair_image_joint(read_image(args.input), args.spatial, args.sigma_y, args.sigma_c)
    write_image(args.output, result)
    report.update(input=args.input, output=args.output, elapsed_seconds=round(perf_counter() - start, 3))
    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
