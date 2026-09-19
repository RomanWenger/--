"""
吉隆口岸泥石流危险场计算模块

以 2025-07-08 冰川湖溃决型泥石流为原型的推演：
  DEM → D8 流向 → 汇流累积 → 主沟谷底线
  → 沿程宽度/流深/流速(Manning) → 堆积扇
  → 逐格 facies / velocity / depth / deposit / flow_dir

不依赖 scipy，均匀滤波用 numpy 手写。
"""
import math
import heapq
from collections import deque

import numpy as np

# ===== 物理常量（文献典型值，留率定接口）=====
RHO = 1600.0        # 泥浆容重 kg/m³
CD = 0.8            # 拖曳系数
A_FRONT = 0.5       # 机器人迎流面积 m²
M = 75.0            # 机器人质量 kg
G = 9.8             # 重力加速度
MU = 0.6            # 摩擦系数

# 安全判据阈值
V_SLIP = 1.17       # 滑移临界流速 m/s（μmg 平衡）
V_OVERTURN = 1.8    # 倾覆临界流速 m/s
DEP_PROH = 0.35     # 淹没禁行流深 m
SINK_PROH = 0.40    # 陷没禁行淤积厚度 m

CELL = 50.0         # 每格真实米数
IMPOSSIBLE = 1e9

# D8 八方向
D8 = [(0, -1), (1, -1), (1, 0), (1, 1),
      (0, 1), (-1, 1), (-1, 0), (-1, -1)]


def _uniform_filter1d(arr, size=5, axis=0):
    """numpy 手写一维均匀滤波，替代 scipy.ndimage.uniform_filter1d"""
    if size <= 1:
        return arr.copy()
    pad = size // 2
    arr_padded = np.pad(arr, [(pad if a == axis else 0, pad if a == axis else 0)
                              for a in range(arr.ndim)], mode='edge')
    kernel = np.ones(size) / size
    return np.apply_along_axis(lambda m: np.convolve(m, kernel, mode='valid'),
                               axis, arr_padded)


def d8_flowdir(dem):
    """每个内点流向 8 邻域中落差（单位距离高差）最大者"""
    n, m = dem.shape
    fd = np.full((n, m), -1, dtype=np.int8)
    for i in range(n):
        for j in range(m):
            best_k, best_drop = -1, 0.0
            for k, (di, dj) in enumerate(D8):
                ii, jj = i + di, j + dj
                if 0 <= ii < n and 0 <= jj < m:
                    drop = (dem[i, j] - dem[ii, jj]) / math.hypot(di, dj)
                    if drop > best_drop:
                        best_drop, best_k = drop, k
            fd[i, j] = best_k
    return fd


def d8_accum(fd):
    """按 D8 流向计算汇流累积面积（上游格点数）"""
    n, m = fd.shape
    acc = np.ones((n, m), dtype=np.float64)
    indeg = np.zeros((n, m), dtype=np.int32)
    for i in range(n):
        for j in range(m):
            k = fd[i, j]
            if k >= 0:
                ii, jj = i + D8[k][0], j + D8[k][1]
                indeg[ii, jj] += 1
    q = deque((i, j) for i in range(n) for j in range(m) if indeg[i, j] == 0)
    while q:
        i, j = q.popleft()
        k = fd[i, j]
        if k < 0:
            continue
        ii, jj = i + D8[k][0], j + D8[k][1]
        acc[ii, jj] += acc[i, j]
        indeg[ii, jj] -= 1
        if indeg[ii, jj] == 0:
            q.append((ii, jj))
    return acc


def main_channel(dem, fd, acc, area_thresh=8):
    """从最大累积出口沿上游最大汇流回溯，得到主沟谷底线（上游→出口）"""
    masked = np.where(acc > area_thresh, acc, 0)
    outlet = np.unravel_index(int(np.argmax(masked)), acc.shape)
    path = [outlet]
    cur = outlet
    visited = {cur}
    while True:
        i, j = cur
        best, best_acc = None, -1.0
        for di, dj in [(-v[0], -v[1]) for v in D8]:
            ii, jj = i + di, j + dj
            if 0 <= ii < dem.shape[0] and 0 <= jj < dem.shape[1]:
                if (ii, jj) in visited or fd[ii, jj] < 0:
                    continue
                ni = ii + D8[fd[ii, jj]][0]
                nj = jj + D8[fd[ii, jj]][1]
                if (ni, nj) == (i, j) and acc[ii, jj] > best_acc:
                    best, best_acc = (ii, jj), acc[ii, jj]
        if best is None:
            break
        visited.add(best)
        path.append(best)
        cur = best
    path.reverse()
    return path


def build_deposit_fan(dem, origin, beta=0.06, peak_scale=1.0):
    """从扇顶沿低坡向扩散，淤积厚度 ~ exp(-beta·s)，随洪峰强度缩放"""
    n, m = dem.shape
    deposit = np.zeros((n, m))
    fan = {}
    q = [(0.0, origin)]
    seen = {origin}
    max_th = 2.2 * peak_scale  # 扇顶最大淤积厚度随强度缩放
    while q:
        s, (i, j) = heapq.heappop(q)
        th = max_th * math.exp(-beta * s / CELL)
        if th < 0.06:
            continue
        deposit[i, j] = max(deposit[i, j], th)
        fan[(i, j)] = th
        for di, dj in D8:
            ii, jj = i + di, j + dj
            if 0 <= ii < n and 0 <= jj < m and (ii, jj) not in seen:
                seen.add((ii, jj))
                # 向低坡/近水平方向扩散（容差按 CELL 比例）
                if dem[ii, jj] <= dem[i, j] + CELL * 0.08:
                    q.append((s + CELL * math.hypot(di, dj), (ii, jj)))
    return deposit, fan


def channel_hazard(dem, fd, acc, chan, peak_scale=1.0):
    """沿主沟计算宽度、流深、流速，并判停生成堆积扇。返回危险场各场"""
    n, m = dem.shape
    v = np.zeros((n, m))
    dep = np.zeros((n, m))
    width = np.zeros((n, m))
    fdirx = np.zeros((n, m))
    fdiry = np.zeros((n, m))
    facies = np.zeros((n, m), dtype=np.int8)

    # 沿程比降
    slope = np.zeros_like(dem)
    for idx in range(len(chan) - 1):
        i0, j0 = chan[idx]
        i1, j1 = chan[idx + 1]
        L = CELL * math.hypot(i1 - i0, j1 - j0)
        slope[i0, j0] = max(0.0, (dem[i0, j0] - dem[i1, j1]) / max(L, 1e-6))
    slope = _uniform_filter1d(slope, size=5, axis=0)

    stop_k = len(chan) - 1
    peak_q = 0.6 + peak_scale * 0.8  # 洪峰过程线缩放（0.6~1.4）

    for k in range(len(chan) - 1):
        i, j = chan[k]
        catch = acc[i, j] * (CELL ** 2) / 1e6  # km²
        w = max(1.5, 2.8 * max(catch, 0.01) ** 0.55)  # m
        n_mud = 0.14 if slope[i, j] > 0.12 else 0.22
        S = max(slope[i, j], 0.01)
        vel = (1.0 / n_mud) * (w ** 0.7) * (S ** 0.5)
        vel = float(np.clip(vel, 0.0, 14.0)) * (0.45 + 0.55 * peak_scale)
        q_local = 0.10 * max(catch, 0.01) ** 0.9 * peak_q
        hgt = q_local / max(RHO * w * max(vel, 0.05) * 0.85, 1e-6)
        hgt = min(hgt, 6.0)

        v[i, j], dep[i, j], width[i, j] = vel, hgt, w

        dk = max(fd[i, j], 0)
        fdiry[i, j], fdirx[i, j] = float(D8[dk][0]), float(D8[dk][1])

        # 先标记当前格，再判停（堆积扇从下一格开始）
        facies[i, j] = 3 if (vel > V_SLIP or hgt > DEP_PROH) else 1

        # 判停：比降 < 3.5° → 进入堆积扇
        if slope[i, j] < math.tan(math.radians(3.5)):
            stop_k = k
            break

    fan_start = chan[min(stop_k, len(chan) - 1)]
    deposit, fan = build_deposit_fan(dem, fan_start, peak_scale=peak_scale)
    for (ii, jj), f in fan.items():
        if facies[ii, jj] == 0:
            facies[ii, jj] = 2
        dep[ii, jj] = max(dep[ii, jj], f * 0.9)
        if f >= SINK_PROH:
            facies[ii, jj] = 3

    return {
        'velocity': v,
        'depth': dep,
        'width': width,
        'fdirx': fdirx,
        'fdiry': fdiry,
        'facies': facies,
        'deposit': deposit,
        'channel': chan,
        'fan_cells': list(fan.keys()),
        'peak_q': peak_q,
    }


def apply_valley_channel_guidance(dem_meters, start_pos=(3, 10), mid_pos=(15, 13), end_pos=(18, 15)):
    """内存 DEM 上生成一条平滑深切引导槽（-2.2m 主轴 / -1.0m 侧翼），引导 D8 流线。

    保持 GLB 源文件与磁盘 DEM 不变，仅对输入的米制高程数组做内存级微地形下压。
    """
    dem_guided = dem_meters.copy()
    n, m = dem_guided.shape

    pts = [start_pos, mid_pos, end_pos]
    guide_coords = []
    for k in range(len(pts) - 1):
        p1, p2 = pts[k], pts[k + 1]
        steps = max(abs(p2[0] - p1[0]), abs(p2[1] - p1[1])) * 2
        for s in range(steps + 1):
            t = s / max(1, steps)
            r = int(round(p1[0] + (p2[0] - p1[0]) * t))
            c = int(round(p1[1] + (p2[1] - p1[1]) * t))
            if 0 <= r < n and 0 <= c < m:
                guide_coords.append((r, c))

    for r, c in guide_coords:
        dem_guided[r, c] -= 2.2            # 主轴下压
        for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nr, nc = r + dr, c + dc
            if 0 <= nr < n and 0 <= nc < m:
                dem_guided[nr, nc] -= 1.0  # 侧翼下压
    return dem_guided


def _extend_to_port(hz, dem, mid=(15, 13), end=(18, 15)):
    """确定性流道延伸：把主沟从自然出口沿槽线直连到南侧受灾口岸。

    说明：main_channel 恒取"汇流累积最大格"为出口，真实地形自然汇于 (9,13)，
    单纯挖窄槽（尤其在 250m 量级高差下）无法把出口搬到东南角。
    这里在 D8 计算结果之上，把主沟按引导线继续下切到目标受灾点并标记淤埋，
    保证 AI 路径/物理推演/3D 泥石流带在东南口岸形成灾害闭环。
    """
    n, m = dem.shape
    hz['channel'] = list(hz['channel'])
    ch = hz['channel']

    def interp_polyline(p1, p2):
        out = []
        steps = max(abs(p2[0] - p1[0]), abs(p2[1] - p1[1])) * 2
        for s in range(steps + 1):
            t = s / max(1, steps)
            r = int(round(p1[0] + (p2[0] - p1[0]) * t))
            c = int(round(p1[1] + (p2[1] - p1[1]) * t))
            if 0 <= r < n and 0 <= c < m and (r, c) not in ch:
                out.append((r, c))
        return out

    last = tuple(int(v) for v in ch[-1]) if ch else (0, 0)
    seg1 = interp_polyline(last, mid)
    seg2 = interp_polyline(mid, end)
    route = seg1 + seg2
    if end in route or end not in [tuple(int(v) for v in c) for c in ch]:
        # 确保终点 (end) 一定在通道内
        for cell in (mid, end):
            r, c = int(cell[0]), int(cell[1])
            if 0 <= r < n and 0 <= c < m and (r, c) not in [tuple(int(v) for v in x) for x in ch]:
                route.append((r, c))

    # 沿延伸路线标记流场
    route_cells = route
    for k, (r, c) in enumerate(route_cells):
        if (r, c) in [tuple(int(v) for v in x) for x in ch]:
            continue
        ch.append([r, c])
        hz['velocity'][r, c] = max(hz['velocity'][r, c], 2.5)
        hz['depth'][r, c] = max(hz['depth'][r, c], 1.5)
        hz['width'][r, c] = max(hz['width'][r, c], 4.0)
        hz['deposit'][r, c] = max(hz['deposit'][r, c], 2.0)
        hz['facies'][r, c] = 3
        # 流向指向下一格
        nxt = route_cells[k + 1] if k + 1 < len(route_cells) else (end[0], end[1])
        dr, dc = nxt[0] - r, nxt[1] - c
        ln = float(np.hypot(dr, dc)) or 1.0
        hz['fdiry'][r, c] = dr / ln
        hz['fdirx'][r, c] = dc / ln

    # 在受灾口岸周边铺扇形淤埋，使 (end) 落入堆积带
    er, ec = int(end[0]), int(end[1])
    for di in range(-2, 3):
        for dj in range(-2, 3):
            rr, cc = er + di, ec + dj
            if 0 <= rr < n and 0 <= cc < m:
                dist = max(abs(di), abs(dj))
                dep = max(1.2 - dist * 0.4, 0.35)
                hz['deposit'][rr, cc] = max(hz['deposit'][rr, cc], dep)
                if dep >= 0.4:
                    hz['facies'][rr, cc] = 3
                elif hz['facies'][rr, cc] == 0:
                    hz['facies'][rr, cc] = 2
                if (rr, cc) not in hz['fan_cells']:
                    hz['fan_cells'].append([rr, cc])
    return hz


def compute_hazard(dem, peak_scale=1.0):
    """完整危险场计算入口"""
    # 1. 内存层引导槽下压（不修改 GLB 源文件 / 磁盘 DEM）
    guided = apply_valley_channel_guidance(dem)

    # 2. 基于下压后的 DEM 执行 D8 计算
    fd = d8_flowdir(guided)
    acc = d8_accum(fd)
    chan = main_channel(guided, fd, acc)
    hz = channel_hazard(guided, fd, acc, chan, peak_scale)
    hz['flow_dir'] = fd
    hz['accum'] = acc

    # 3. 确定性流道延伸：确保灾害链抵达东南受灾口岸 (18,15)
    hz = _extend_to_port(hz, guided)
    return hz


def _step_slope_deg(dem, cur, nxt):
    """该步的局部坡度（度）。用落脚点周围高差估计。"""
    cx, cy = cur
    nx, ny = nxt
    L = CELL * math.hypot(nx - cx, ny - cy)
    dh = float(dem[nx, ny] - dem[cx, cy])
    if L < 1e-6:
        return 0.0
    return float(math.degrees(math.atan2(abs(dh), L)))


def step_info(dem, hz, cur, nxt, peak_scale=1.0):
    """单步信息：返回 {cost, slope_risk, debris_risk, slope_deg, velocity, depth, deposit}
    cost 为 IMPOSSIBLE 表示绝对不可通行（断桥由调用方另行处理）。"""
    cx, cy = cur
    nx, ny = nxt
    if nx < 0 or ny < 0 or nx >= dem.shape[0] or ny >= dem.shape[1]:
        return {'cost': IMPOSSIBLE, 'slope_risk': 1.0, 'debris_risk': 1.0,
                'slope_deg': 90.0, 'velocity': 0.0, 'depth': 0.0, 'deposit': 0.0}

    L = CELL * math.hypot(nx - cx, ny - cy)
    dh = float(dem[nx, ny] - dem[cx, cy])

    # 1. 基础距离代价
    cost = L / 100.0
    # 2. 上下坡代价
    if dh > 0:
        cost += dh * 0.18
    else:
        cost += abs(dh) * 0.035

    # 3. 坡度代价（极陡坡才禁行）
    slope_deg = _step_slope_deg(dem, cur, nxt)
    # 地形起伏滑块是视觉/教学夸张尺度；高起伏时不能把大量相邻格
    # 一刀切成禁行，否则 A* 无路可走并退化成起点到终点的直线。
    # 仍然对陡坡施加强惩罚，让规划优先绕行。
    slope_ratio = min(slope_deg / 42.0, 1.0)
    slope_risk = slope_ratio
    cost += (slope_ratio ** 2) * 6.0
    if slope_deg > 58.0:
        return {'cost': IMPOSSIBLE, 'slope_risk': 1.0, 'debris_risk': 0.0,
                'slope_deg': slope_deg, 'velocity': 0.0, 'depth': 0.0, 'deposit': 0.0}

    # 4. 泥石流分级代价（流速/流深/淤积）
    v = float(hz['velocity'][nx, ny]) * peak_scale
    h = float(hz['depth'][nx, ny])
    sink = float(hz['deposit'][nx, ny])

    debris_cost = (
        0.55 * min(v / 5.0, 1.0) +
        0.35 * min(h / 1.5, 1.0) +
        0.25 * min(sink / 1.5, 1.0)
    )
    debris_risk = min(debris_cost, 1.0)
    cost += debris_cost * 5.0

    # 5. 横切流向的额外代价
    fdx = float(hz['fdirx'][nx, ny])
    fdy = float(hz['fdiry'][nx, ny])
    fn = math.hypot(fdx, fdy)
    if fn > 1e-6:
        fdx, fdy = fdx / fn, fdy / fn
        mv_i, mv_j = nx - cx, ny - cy
        mv_len = math.hypot(mv_i, mv_j) or 1.0
        direction_cos = (mv_i * fdy + mv_j * fdx) / mv_len  # (行,列)流向
        cross_flow = 1.0 - abs(direction_cos)
        cost += cross_flow * v * 0.75

    # 6. 仅极端条件才禁行（让 AI 有"绕行学习"空间）
    if h > 2.2:
        return {'cost': IMPOSSIBLE, 'slope_risk': slope_risk, 'debris_risk': 1.0,
                'slope_deg': slope_deg, 'velocity': v, 'depth': h, 'deposit': sink}
    if v > 7.0 and h > 1.2:
        return {'cost': IMPOSSIBLE, 'slope_risk': slope_risk, 'debris_risk': 1.0,
                'slope_deg': slope_deg, 'velocity': v, 'depth': h, 'deposit': sink}
    if sink > 2.0:
        return {'cost': IMPOSSIBLE, 'slope_risk': slope_risk, 'debris_risk': 1.0,
                'slope_deg': slope_deg, 'velocity': v, 'depth': h, 'deposit': sink}

    return {'cost': cost, 'slope_risk': slope_risk, 'debris_risk': debris_risk,
            'slope_deg': slope_deg, 'velocity': v, 'depth': h, 'deposit': sink}


def step_cost(dem, hz, cur, nxt, peak_scale=1.0):
    """A* 用：仅返回代价值（IMPOSSIBLE 表示禁行）。"""
    return step_info(dem, hz, cur, nxt, peak_scale)['cost']
