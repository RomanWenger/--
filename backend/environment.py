"""
吉隆口岸泥石流救援仿真环境 — 以 2025-07-08 冰川湖溃决型泥石流为原型的推演

地形驱动危险场：DEM → D8 汇流 → 主沟 → 沿程水动力 → 堆积扇 → 逐格 facies
DQN 观测扩展到 19 维，代价函数含滑移/淹没/陷没三条硬禁行。
"""
import os
import math
import numpy as np

from hazard import (
    compute_hazard, step_cost, CELL,
    V_SLIP, V_OVERTURN, DEP_PROH, SINK_PROH, IMPOSSIBLE,
)

GRID_SIZE = 20
STATE_DIM = 19
ACTION_DIM = 4

# 语义地标（20x20 网格坐标）
# 地理逻辑：西北/后方安全高地(指挥所/安置点) → 中部纵切断谷(主冲沟/断桥) →
#          东南下游谷底受灾带(吉隆口岸·热索桥)
LANDMARK_DEFS = {
    'staging':   (2, 4),    # 吉隆救援指挥所：西北/后方安全高地，影响带外
    'trapped':   (18, 15),  # 吉隆口岸·热索桥：东南下游谷底受灾点
    'bridge':    (15, 13),  # 热索桥被毁断桥位：主冲沟中部横切点
    'shelter':   (1, 10),   # 后方应急避难安置点：北部相对安全高地
}


class MountainRescueEnv:
    def __init__(self, grid_size=GRID_SIZE, amplitude=1.0, dem=None):
        self.grid_size = grid_size
        self.amplitude = amplitude
        self.n = grid_size
        self.m = grid_size
        self.cell = CELL

        # 地形：优先加载真实 DEM（前端导出），回退程序化
        if dem is not None:
            self.base_terrain = dem
        else:
            self.base_terrain = self._load_or_generate_dem()

        self.terrain = self._scale_terrain(amplitude)

        # 语义地标
        self.landmark_defs = dict(LANDMARK_DEFS)
        self.start = self.landmark_defs['staging']
        self.goal = self.landmark_defs['trapped']

        # 断桥/断路硬断点 + 抢修便道（围绕热索桥断桥位 (15,13)）
        self.blocked_edges = {
            ((15, 13), (15, 14)),
            ((15, 14), (15, 13)),
            ((14, 13), (15, 12)),
            ((15, 12), (14, 13)),
            ((15, 13), (14, 13)),
            ((14, 13), (15, 13)),
        }
        self.bypass_cells = {(16, 14), (17, 14), (18, 14)}

        # 危险场缓存
        self.peak_scale = 0.5
        self._hazard = None
        self._hazard_scale = None

        self.state = None
        self.wind_speed = 0.5  # 兼容字段，实际用 peak_scale

    # ===== DEM 加载 =====
    def _load_or_generate_dem(self):
        dem_path = os.path.join(os.path.dirname(__file__), 'dem_kyirong.npy')
        if os.path.exists(dem_path):
            try:
                dem = np.load(dem_path).astype(np.float64)
                if dem.shape == (GRID_SIZE, GRID_SIZE):
                    return self._to_meters(dem)
            except Exception:
                pass
        # 回退：程序化吉隆峡谷（深切沟谷，东南流向）
        return self._programmatic_dem()

    def _to_meters(self, raw):
        """把归一化 DEM 缩放到真实米制：谷底 2800m，相对高差 150-350m"""
        raw = raw.astype(np.float64)
        rmin, rmax = float(raw.min()), float(raw.max())
        rng = max(rmax - rmin, 1e-6)
        rel = (raw - rmin) / rng  # 0..1
        return 2800.0 + rel * 250.0  # 相对高差 250m

    def _programmatic_dem(self):
        np.random.seed(42)
        gs = self.grid_size
        x = np.linspace(0, 1, gs)
        y = np.linspace(0, 1, gs)
        X, Y = np.meshgrid(x, y)
        # 深切河谷：中间低两侧抬升，整体东南倾（增强坡度以形成真实流通区）
        valley = np.power(np.abs(Y - 0.5) * 2.2, 1.6) * 9.0
        ridge = np.sin(X * 7 + Y * 4) * 1.2 + np.sin(X * 3.5 - Y * 6) * 1.8
        gully = np.maximum(0, 4.0 - np.sqrt((X - 0.2) ** 2 + (Y - 0.3) ** 2) * 7)
        trend = (X + Y) * 3.0  # 更强的纵向比降
        noise = np.random.rand(gs, gs) * 1.2
        terrain = 1.5 + valley + ridge + gully + trend + noise
        terrain = (terrain - terrain.min()) / (terrain.max() - terrain.min()) * 10
        return self._to_meters(terrain)

    def _scale_terrain(self, amplitude):
        mid = float(self.base_terrain.mean())
        return mid + (self.base_terrain - mid) * amplitude

    def set_amplitude(self, amplitude):
        self.amplitude = amplitude
        self.terrain = self._scale_terrain(amplitude)
        self._hazard = None  # 地形变了需重算危险场

    # ===== 危险场 =====
    def get_hazard(self, peak_scale=0.5):
        if self._hazard is not None and self._hazard_scale == peak_scale:
            return self._hazard
        self.peak_scale = peak_scale
        self._hazard = compute_hazard(self.terrain, peak_scale)
        self._hazard_scale = peak_scale
        return self._hazard

    def get_dem(self):
        return self.terrain

    # ===== 地标校验 =====
    def validate_landmarks(self):
        out = {}
        for name, (i, j) in self.landmark_defs.items():
            out[name] = {
                'grid': [int(i), int(j)],
                'height_m': float(self.terrain[i, j]),
                'facies': int(self.get_hazard(self.peak_scale)['facies'][i, j]),
            }
        return out

    # ===== RL 接口 =====
    def reset(self, wind_speed=0.5):
        self.state = np.array(self.start, dtype=np.float32)
        self.wind_speed = wind_speed
        self.peak_scale = wind_speed
        self.get_hazard(wind_speed)
        return self._get_obs()

    def _get_obs(self):
        x, y = self.state.astype(int)
        x = int(np.clip(x, 0, self.n - 1))
        y = int(np.clip(y, 0, self.m - 1))
        hz = self.get_hazard(self.peak_scale)

        feats = [x / (self.n - 1), y / (self.m - 1), self.peak_scale]
        # 当前格危险度
        feats += [
            float(np.clip(hz['velocity'][x, y] / 8.0, 0, 1)),
            float(np.clip(hz['depth'][x, y] / 2.0, 0, 1)),
            float(np.clip(hz['deposit'][x, y] / 0.6, 0, 1)),
            float(np.clip(hz['facies'][x, y] / 3.0, 0, 1)),
        ]
        # 四邻域：坡度差、流速、禁行标记
        for di, dj in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            ni = int(np.clip(x + di, 0, self.n - 1))
            nj = int(np.clip(y + dj, 0, self.m - 1))
            dd = self.terrain[ni, nj] - self.terrain[x, y]
            feats += [
                float(np.clip(dd / 30.0, -1, 1)),
                float(np.clip(hz['velocity'][ni, nj] / 4.0, 0, 1)),
                1.0 if hz['facies'][ni, nj] == 3 else 0.0,
            ]
        return np.array(feats, dtype=np.float32)  # 3+4+12=19

    def step(self, action):
        x, y = self.state.astype(int)
        if action == 0:
            nx = max(0, x - 1)
        elif action == 1:
            nx = min(self.n - 1, x + 1)
        elif action == 2:
            ny = max(0, y - 1)
            nx = x
        elif action == 3:
            ny = min(self.m - 1, y + 1)
            nx = x
        if action in (0, 1):
            ny = y

        cur = (int(x), int(y))
        nxt = (int(nx), int(ny))
        hz = self.get_hazard(self.peak_scale)

        # 断桥硬断点
        if (cur, nxt) in self.blocked_edges or (nxt, cur) in self.blocked_edges:
            self.state = np.array(nxt, dtype=np.float32)
            return self._get_obs(), -25.0, False, IMPOSSIBLE

        cost = step_cost(self.terrain, hz, cur, nxt, self.peak_scale)
        if cost >= IMPOSSIBLE:
            # 撞进禁行区
            self.state = np.array(nxt, dtype=np.float32)
            return self._get_obs(), -25.0, False, cost

        reward = -cost
        done = False
        if nx == self.goal[0] and ny == self.goal[1]:
            reward = 100.0
            done = True
        self.state = np.array(nxt, dtype=np.float32)
        return self._get_obs(), reward, done, cost

    def get_terrain_data(self):
        return self.terrain.tolist()
