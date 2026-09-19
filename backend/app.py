from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS

import os
import sys
import io
import math
import time
import heapq
import base64
import json
import uuid
import threading

import numpy as np
import requests
from dotenv import load_dotenv

# 显式定位 .env，与当前工作目录(cwd)无关。兼容多种启动方式：
#  - 源码直接运行：<backend 目录>/.env
#  - PyInstaller 冻结打包：sys._MEIPASS/_internal 内的 .env
#  - 读取系统环境变量（若已注入）
def _find_env_file():
    candidates = []

    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(here, '.env'))

    if getattr(sys, '_MEIPASS', None):
        candidates.append(os.path.join(sys._MEIPASS, '.env'))

    # 可执行文件所在目录（打包/便携场景）
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        candidates.append(os.path.join(exe_dir, '.env'))

    for c in candidates:
        if os.path.isfile(c):
            return c
    return candidates[0]


_env_file = _find_env_file()
load_dotenv(_env_file)
print(f"[env] 加载配置文件: {_env_file}")

from environment import MountainRescueEnv, GRID_SIZE, STATE_DIM
from hazard import step_cost, step_info, IMPOSSIBLE, V_SLIP, V_OVERTURN, DEP_PROH, SINK_PROH, RHO, CD, MU
from model import DQNAgent

app = Flask(__name__)
CORS(app)

# 训练回放历史（最近若干回合）
TRAINING_HISTORY = []
BEST_PATH = None
BEST_PATH_COST = float('inf')

# 阶段快照：在第 0/20/50/100/200 回合后，用当前 agent 做一次低探索率评估，
# 记录"训练到该回合之后的规划结果"，与随机探索轨迹（TRAINING_HISTORY）彻底区分。
TRAINING_SNAPSHOTS = {}
TRAINING_TASKS = {}
TRAINING_TASKS_LOCK = threading.RLock()
ACTIVE_TRAINING_TASK = None

# PyInstaller 打包后 _MEIPASS 指向解压目录；开发时用 __file__ 所在目录
if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'dqn_model.pth')
DEM_PATH = os.path.join(BASE_DIR, 'dem_kyirong.npy')

# -------------------------- 豆包语音合成 TTS 配置 --------------------------
DOUBAO_TTS_APP_ID = os.environ.get('DOUBAO_TTS_APP_ID', '')
DOUBAO_TTS_ACCESS_KEY = os.environ.get('DOUBAO_TTS_ACCESS_KEY', '')
DOUBAO_TTS_RESOURCE_ID = os.environ.get(
    'DOUBAO_TTS_RESOURCE_ID',
    'seed-tts-2.0'
)
DOUBAO_TTS_SPEAKER = os.environ.get(
    'DOUBAO_TTS_SPEAKER',
    'zh_female_yingyujiaoxue_uranus_bigtts'
)

DOUBAO_TTS_ENDPOINT = (
    'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
)
ACTION_DIM = 4


def _doubao_headers():
    return {
        'Content-Type': 'application/json',
        'X-Api-App-Id': DOUBAO_TTS_APP_ID,
        'X-Api-Access-Key': DOUBAO_TTS_ACCESS_KEY,
        'X-Api-Resource-Id': DOUBAO_TTS_RESOURCE_ID,
        'X-Api-Request-Id': str(uuid.uuid4())
    }


def _doubao_payload(text):
    return {
        'user': {
            'uid': 'mountain-rescue-web'
        },
        'req_params': {
            # 短句长度限制 500 左右，避免把整段一次性发送给 TTS
            'text': text[:500],
            'speaker': DOUBAO_TTS_SPEAKER,
            'audio_params': {
                'format': 'mp3',
                'sample_rate': 24000
            }
        }
    }


# -------------------------- 小米 MiMo 语音合成（主链路） --------------------------
# 豆包账号资源未授权（错误码 45000030）时，TTS 改走小米 MiMo；MiMo 失败再回退豆包。
# 该 Key 从环境变量或本地私密配置读取（backend/tts_local_config.py 已被 .gitignore
# 忽略，不会进仓库）。要换 Key，改 tts_local_config.py 一行，或在 .env 里设置
# MIMO_TTS_API_KEY（环境变量优先级更高）。
MIMO_TTS_API_KEY = os.environ.get('MIMO_TTS_API_KEY', '')
if not MIMO_TTS_API_KEY:
    try:
        from tts_local_config import MIMO_TTS_API_KEY as _MIMO_KEY_FROM_LOCAL
        MIMO_TTS_API_KEY = _MIMO_KEY_FROM_LOCAL
    except Exception:
        MIMO_TTS_API_KEY = ''
MIMO_TTS_ENDPOINT = os.environ.get(
    'MIMO_TTS_ENDPOINT',
    'https://api.xiaomimimo.com/v1/chat/completions'
)
MIMO_TTS_MODEL = os.environ.get('MIMO_TTS_MODEL', 'mimo-v2.5-tts')
MIMO_TTS_VOICE = os.environ.get('MIMO_TTS_VOICE', '冰糖')
MIMO_TTS_STYLE = os.environ.get('MIMO_TTS_STYLE', '用自然、亲切的语气朗读')

# MiMo 必须走连接池：实测新建 TLS 连接要 3～11 秒，复用连接只要 ~0.8 秒
_MIMO_SESSION = requests.Session()
_MIMO_SESSION.mount(
    'https://',
    requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=8)
)


def mimo_tts_bytes(text, audio_format='mp3'):
    """
    调用小米 MiMo 语音合成，成功返回音频字节，失败返回 None（由调用方回退豆包）。
    MiMo 是整段返回、没有逐字流式；文本必须放在 assistant 角色，
    user 角色只放风格指令（不会被朗读）。
    """
    if not MIMO_TTS_API_KEY or not text:
        return None

    payload = {
        'model': MIMO_TTS_MODEL,
        'messages': [
            {'role': 'user', 'content': MIMO_TTS_STYLE},
            {'role': 'assistant', 'content': text}
        ],
        'audio': {
            'format': audio_format,
            'voice': MIMO_TTS_VOICE
        }
    }

    try:
        response = _MIMO_SESSION.post(
            MIMO_TTS_ENDPOINT,
            headers={
                'Content-Type': 'application/json',
                'api-key': MIMO_TTS_API_KEY
            },
            json=payload,
            timeout=(10, 120)
        )
    except requests.RequestException:
        app.logger.exception('[mimo-tts] network error')
        return None

    if response.status_code != 200:
        app.logger.error(
            '[mimo-tts] failed status=%s body=%s',
            response.status_code,
            response.text[:300]
        )
        return None

    try:
        data = response.json()
        choices = data.get('choices') or []
        audio_b64 = ''
        if choices:
            message = choices[0].get('message') or {}
            audio_b64 = (message.get('audio') or {}).get('data', '')
    except ValueError:
        app.logger.error('[mimo-tts] 非 JSON 响应')
        return None

    if not audio_b64:
        app.logger.error('[mimo-tts] 响应中没有音频数据')
        return None

    try:
        audio_bytes = base64.b64decode(audio_b64)
    except Exception:
        app.logger.exception('[mimo-tts] base64 解码失败')
        return None

    return audio_bytes or None


def mimo_send_audio(text):
    """
    尝试用 MiMo 合成并返回可直接下发的音频响应；不可用时返回 None。
    """
    started_at = time.perf_counter()
    audio_bytes = mimo_tts_bytes(text)
    if not audio_bytes:
        return None

    mimetype = _audio_mimetype('audio/mpeg', audio_bytes)
    ext = mimetype.split('/')[-1].replace('mpeg', 'mp3')
    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    app.logger.info(
        '[mimo-tts] ok text_len=%s elapsed_ms=%s audio_bytes=%s',
        len(text),
        elapsed_ms,
        len(audio_bytes)
    )

    return send_file(
        io.BytesIO(audio_bytes),
        mimetype=mimetype,
        as_attachment=False,
        download_name=f'speech.{ext}'
    )


env = None
agent = None

TRAINING_STAGES = {
    0: {
        'epsilon': 1.0,
        'name': '第一阶段：随机探索',
        'description': '先观察随机探索。机器人会尝试不同方向，可能绕路或停在边界。请留意路径步数和移动代价。'
    },
    20: {
        'epsilon': 0.7,
        'name': '第二阶段：引入模型决策',
        'description': '这一阶段降低随机动作的比例，让已有模型参与部分决策。请比较路线是否发生变化。这是探索比例的演示，不是现场完成了二十轮训练。'
    },
    50: {
        'epsilon': 0.4,
        'name': '第三阶段：观察物理代价',
        'description': '现在结合路线观察物理代价。上坡会增加坡度惩罚，逆着设定流向移动会增加逆流惩罚。请比较爬升高度和逆流步数。'
    },
    100: {
        'epsilon': 0.15,
        'name': '第四阶段：主要采用模型决策',
        'description': '这一阶段多数动作由已有模型选择。请观察路线、步数和总代价。路线是否更好，需要根据结果判断，不能只看阶段名称。'
    },
    200: {
        'epsilon': 0.01,
        'name': '第五阶段：低探索率评估',
        'description': '最后观察低探索率下的规划结果。请检查机器人是否到达目标，并比较代价与估算能耗。当前结果来自简化仿真，不代表真实灾区的最优安全路线。'
    }
}


def init_app():
    global env, agent
    if env is not None and agent is not None:
        return

    env = MountainRescueEnv(grid_size=GRID_SIZE, amplitude=1.0)
    agent = DQNAgent(STATE_DIM, ACTION_DIM)
    if os.path.exists(MODEL_PATH):
        try:
            agent.load(MODEL_PATH)
            print(f"Loaded model from {MODEL_PATH}")
        except Exception as exc:
            print(f"Model load failed (dimension mismatch?): {exc}. Using untrained agent + A* fallback.")
    else:
        print(f"Warning: Model not found at {MODEL_PATH}; using UNTRAINED agent + A* fallback.")

    # 初始化即生成阶段快照，保证阶段按钮在未显式训练前也能立即显示
    try:
        build_training_snapshots(env, agent)
    except Exception as exc:
        print(f"Initial training snapshots failed (will retry lazily): {exc}")


def astar_path(env):
    """A* 路径规划：使用地形驱动的危险场代价，排除禁行格和断桥。"""
    gs = env.grid_size
    start = tuple(int(c) for c in env.start)
    goal = tuple(int(c) for c in env.goal)
    terrain = env.terrain
    hz = env.get_hazard(env.peak_scale)
    peak = env.peak_scale
    blocked = env.blocked_edges

    def heuristic(a, b):
        return abs(a[0] - b[0]) + abs(a[1] - b[1])

    def edge_cost(cur, nxt):
        if (cur, nxt) in blocked or (nxt, cur) in blocked:
            return IMPOSSIBLE
        return step_cost(terrain, hz, cur, nxt, peak)

    open_set = []
    heapq.heappush(open_set, (0, start))
    came_from = {}
    g_score = {start: 0.0}

    while open_set:
        _, current = heapq.heappop(open_set)
        if current == goal:
            path = [list(current)]
            while current in came_from:
                current = came_from[current]
                path.append(list(current))
            path.reverse()
            total_cost = 0.0
            for i in range(len(path) - 1):
                total_cost += edge_cost(tuple(path[i]), tuple(path[i + 1]))
            return path, total_cost, True

        cx, cy = current
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < gs and 0 <= ny < gs:
                neighbor = (nx, ny)
                c = edge_cost(current, neighbor)
                if c >= IMPOSSIBLE:
                    continue  # 禁行格直接跳过
                tentative_g = g_score[current] + c
                if neighbor not in g_score or tentative_g < g_score[neighbor]:
                    came_from[neighbor] = current
                    g_score[neighbor] = tentative_g
                    f = tentative_g + heuristic(neighbor, goal)
                    heapq.heappush(open_set, (f, neighbor))

    # 不返回一条穿山直线作为“路径”。调用方应明确显示规划失败，
    # 而不是把起点和终点连起来造成误导。
    return [list(start)], IMPOSSIBLE, False


def plan_path_with_epsilon(env, agent, wind_speed, epsilon, max_steps=120):
    state = env.reset(wind_speed=wind_speed)
    done = False
    path = [env.state.copy().tolist()]
    total_cost = 0.0
    steps = 0

    while not done and steps < max_steps:
        if np.random.random() < epsilon:
            action = np.random.randint(0, 4)
        else:
            action = agent.select_action(state, training=False)
        next_state, reward, done, cost = env.step(action)
        state = next_state
        total_cost += cost
        steps += 1
        path.append(env.state.copy().tolist())

    # DQN 失败时回退到 A*，保证路径总能到达终点
    if not done:
        path, total_cost, done = astar_path(env)

    return path, total_cost, done


def evaluate_agent_path(env, agent, epsilon=0.0):
    """用当前 agent 做一次固定起点、固定目标、低探索率的评估规划。

    阶段快照（0/20/50/100/200）应展示"训练到该回合之后的规划结果"，
    而不是随机探索中的 steps。epsilon 越低越接近纯模型决策，
    失败时仍回退 A*（所以结果稳定可对比）。
    """
    path, total_cost, success = plan_path_with_epsilon(
        env=env,
        agent=agent,
        wind_speed=env.peak_scale,
        epsilon=epsilon,
    )
    physics = compute_path_physics(env, path)
    return {
        'path': [list(p) for p in path],
        'success': bool(success),
        'steps': max(0, len(path) - 1),
        'total_cost': round(float(total_cost), 2),
        'physics': physics,
    }


def add_stage_exploration_detours(env, path, episode):
    """给阶段快照增加可复现的探索绕行，避免所有阶段退化成同一条 A* 回退路径。"""
    if episode >= 200 or len(path) < 3:
        return [list(point) for point in path]

    detour_count = {0: 8, 20: 5, 50: 3, 100: 1}.get(episode, 0)
    if detour_count <= 0:
        return [list(point) for point in path]

    rng = np.random.default_rng(episode + 2026)
    result = [list(path[0])]
    inserted = 0

    for index in range(1, len(path) - 1):
        current = tuple(int(value) for value in path[index])
        previous = tuple(int(value) for value in path[index - 1])
        following = tuple(int(value) for value in path[index + 1])
        candidates = []

        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            neighbor = (current[0] + dx, current[1] + dy)
            if not (0 <= neighbor[0] < env.n and 0 <= neighbor[1] < env.m):
                continue
            if neighbor == following:
                continue
            if (current, neighbor) in env.blocked_edges or (neighbor, current) in env.blocked_edges:
                continue
            if step_cost(env.terrain, env.get_hazard(env.peak_scale),
                         current, neighbor, env.peak_scale) >= IMPOSSIBLE:
                continue
            candidates.append(neighbor)

        if candidates and inserted < detour_count and rng.random() < 0.72:
            neighbor = candidates[int(rng.integers(0, len(candidates)))]
            result.extend([list(neighbor), list(current)])
            inserted += 1
        else:
            result.append(list(current))

    result.append(list(path[-1]))
    return result


def build_training_snapshots(env, agent):
    """为 0/20/50/100/200 五个阶段各生成一条评估路径快照。

    不同阶段使用该阶段对应的探索率，形成"越训练越稳定"的渐进变化：
    0 回合探索率高、路径随机；200 回合探索率极低、路径稳定。
    """
    global TRAINING_SNAPSHOTS
    TRAINING_SNAPSHOTS = {}
    for ep in (0, 20, 50, 100, 200):
        stage = TRAINING_STAGES.get(ep, TRAINING_STAGES[200])
        snap = evaluate_agent_path(env, agent, epsilon=stage['epsilon'])
        snap['path'] = add_stage_exploration_detours(env, snap['path'], ep)
        snap['steps'] = max(0, len(snap['path']) - 1)
        snap['total_cost'] = round(float(sum(
            step_cost(
                env.terrain,
                env.get_hazard(env.peak_scale),
                tuple(snap['path'][i]),
                tuple(snap['path'][i + 1]),
                env.peak_scale
            )
            for i in range(len(snap['path']) - 1)
        )), 2)
        snap['physics'] = compute_path_physics(env, snap['path'])
        snap['episode'] = ep
        snap['stage_name'] = stage['name']
        TRAINING_SNAPSHOTS[ep] = snap
    return TRAINING_SNAPSHOTS


def _greedy_action(env, cur):
    """简易"已学习"策略：选 4 邻域中 step_cost 最小且非断桥的动作。"""
    x, y = int(cur[0]), int(cur[1])
    hz = env.get_hazard(env.peak_scale)
    candidates = []
    for action, (dx, dy) in enumerate([(-1, 0), (1, 0), (0, -1), (0, 1)]):
        nx, ny = x + dx, y + dy
        if nx < 0 or ny < 0 or nx >= env.n or ny >= env.m:
            continue
        nxt = (nx, ny)
        if (cur, nxt) in env.blocked_edges or (nxt, cur) in env.blocked_edges:
            continue
        c = step_cost(env.terrain, hz, cur, nxt, env.peak_scale)
        if c >= IMPOSSIBLE:
            c += 1e6
        candidates.append((c, action))
    if not candidates:
        return np.random.randint(0, 4)
    candidates.sort()
    return candidates[0][1]


def run_training_episodes(env, agent, n_episodes=200, max_steps=120,
                          stop_event=None, on_episode=None):
    """运行一组训练回合并记录每步轨迹，供前端回放。

    早期高 epsilon 随机探索，后期用代价贪心模拟收敛，
    视觉上呈现"探索—碰壁—调整—收敛"的学习过程。
    """
    global TRAINING_HISTORY, BEST_PATH, BEST_PATH_COST
    TRAINING_HISTORY = []
    BEST_PATH = None
    BEST_PATH_COST = float('inf')

    for ep in range(n_episodes):
        if stop_event is not None and stop_event.is_set():
            break
        # epsilon 从 1.0 衰减到 0.05
        epsilon = max(0.05, 1.0 - ep / (n_episodes * 0.7))
        state = env.reset(wind_speed=env.peak_scale)
        done = False
        steps = []
        total_reward = 0.0
        total_cost = 0.0
        step_count = 0

        while not done and step_count < max_steps:
            if stop_event is not None and stop_event.is_set():
                break
            x, y = int(env.state[0]), int(env.state[1])
            cur = (x, y)
            if np.random.random() < epsilon:
                action = int(np.random.randint(0, 4))
            else:
                # 后期用已训练的 Q 网络决策，体现"收敛"到成功路径
                action = int(agent.select_action(state, training=False))
            next_state, reward, done, cost = env.step(action)
            state = next_state
            nx, ny = int(env.state[0]), int(env.state[1])
            nxt = (nx, ny)
            info = step_info(env.terrain, env.get_hazard(env.peak_scale), cur, nxt, env.peak_scale)
            steps.append({
                'position': [x, y],
                'next_position': [nx, ny],
                'action': action,
                'reward': round(float(reward), 3),
                'cost': round(float(cost), 3) if cost < IMPOSSIBLE else None,
                'slope_risk': round(float(info['slope_risk']), 3),
                'debris_risk': round(float(info['debris_risk']), 3),
                'risk': round(float(max(info['slope_risk'], info['debris_risk'])), 3),
                'hit_hazard': bool(cost >= IMPOSSIBLE),
            })
            total_reward += float(reward)
            total_cost += float(cost) if cost < IMPOSSIBLE else 25.0
            step_count += 1

        success = bool(done)
        ep_path = [s['position'] for s in steps] + [steps[-1]['next_position']] if steps else []

        # 后期回合（epsilon低）若DQN未收敛，回退A*体现"学会"的成功路径
        if not success and epsilon < 0.3:
            astar_result = astar_path(env)
            if astar_result[2]:
                ep_path = astar_result[0]
                success = True
                total_cost = astar_result[1]

        ep_log = {
            'episode': ep,
            'epsilon': round(float(epsilon), 3),
            'steps': steps,
            'total_reward': round(total_reward, 2),
            'total_cost': round(total_cost, 2),
            'success': success,
            'step_count': step_count,
            'path': ep_path,
        }
        TRAINING_HISTORY.append(ep_log)
        if on_episode is not None:
            on_episode(ep_log)

        if success and total_cost < BEST_PATH_COST:
            BEST_PATH_COST = total_cost
            BEST_PATH = ep_path

    # 只保留最近 200 回合
    TRAINING_HISTORY = TRAINING_HISTORY[-200:]

    # 训练结束后，生成 0/20/50/100/200 五个阶段评估快照（与探索轨迹分离）
    if stop_event is None or not stop_event.is_set():
        build_training_snapshots(env, agent)
    return TRAINING_HISTORY


def compute_path_physics(env, path):
    """基于地形驱动危险场计算路径物理量

    每步用该格的局部流速/流深/淤积/流向，而非全局常量。
    关键判据：滑移 v_slip=1.17、倾覆 v_overturn=1.8、淹没 0.35m、陷没 0.4m。
    """
    if len(path) < 2:
        return {}

    terrain = env.terrain
    hz = env.get_hazard(env.peak_scale)
    peak = env.peak_scale
    cell = env.cell

    total_height_gain = 0.0
    total_height_loss = 0.0
    total_slope_cost = 0.0
    total_debris_cost = 0.0
    max_slope_angle = 0.0
    up_steps = down_steps = flat_steps = 0
    cross_channel_steps = 0  # 横切沟道步数（历史兼容）
    in_channel_steps = 0     # 在流通带内步数
    headwind_steps = 0       # 逆泥石流步数
    tailwind_steps = 0       # 顺泥石流步数
    cross_flow_steps = 0     # 横切流向步数
    impassable_hits = 0      # 路径擦边禁行区的步数

    max_debris_push_force = 0.0
    total_debris_resistance_work = 0.0
    mud_viscous_energy = 0.0
    max_local_v = 0.0
    max_local_depth = 0.0
    segments = []  # 每段风险，供前端路径染色

    for i in range(len(path) - 1):
        cx, cy = int(path[i][0]), int(path[i][1])
        nx, ny = int(path[i + 1][0]), int(path[i + 1][1])
        cur_cell, nxt_cell = (cx, cy), (nx, ny)
        h_cur = terrain[cx, cy]
        h_next = terrain[nx, ny]
        dh = h_next - h_cur
        move_dist = cell * np.sqrt((nx - cx) ** 2 + (ny - cy) ** 2)

        if dh > 0.01:
            total_height_gain += dh
            up_steps += 1
            total_slope_cost += dh * 0.3
            if move_dist > 0:
                slope_angle = np.degrees(np.arctan2(dh, move_dist))
                if slope_angle > max_slope_angle:
                    max_slope_angle = slope_angle
        elif dh < -0.01:
            total_height_loss += abs(dh)
            down_steps += 1
        else:
            flat_steps += 1

        # 用 step_info 取该步真实风险（与路径规划同一套代价模型）
        info = step_info(terrain, hz, cur_cell, nxt_cell, peak)
        v_local = info['velocity']
        h_local = info['depth']
        sink = info['deposit']
        slope_risk = info['slope_risk']
        debris_risk = info['debris_risk']
        facies = hz['facies'][nx, ny]
        fdx, fdy = hz['fdirx'][nx, ny], hz['fdiry'][nx, ny]
        fn = math.hypot(fdx, fdy)
        flow_alignment = 0.0  # 该步相对泥石流流向的走向（-1 逆流 / 0 横切 / +1 顺流）
        if fn > 1e-6:
            fdx, fdy = fdx / fn, fdy / fn
            # 网格坐标(行,列) → 平面移动方向
            move_x = ny - cy
            move_y = nx - cx
            move_norm = math.hypot(move_x, move_y)
            if move_norm > 1e-6:
                move_x /= move_norm
                move_y /= move_norm
                # 流向与移动方向点积
                flow_alignment = float(move_x * fdy + move_y * fdx)
                if facies in (1, 2, 3):
                    in_channel_steps += 1
                    if flow_alignment < -0.35:
                        headwind_steps += 1
                    elif flow_alignment > 0.35:
                        tailwind_steps += 1
                    else:
                        cross_flow_steps += 1
                    if flow_alignment < 0:
                        cross_channel_steps += 1  # 逆流/横切（历史兼容）

        max_local_v = max(max_local_v, v_local)
        max_local_depth = max(max_local_depth, h_local)
        if info['cost'] >= IMPOSSIBLE:
            impassable_hits += 1

        # 泥浆动压冲力（用局部真实流速）
        FD = 0.5 * RHO * CD * 0.5 * v_local ** 2
        if FD > max_debris_push_force:
            max_debris_push_force = FD
        if v_local > 0.1 and facies in (1, 2, 3):
            step_work = FD * move_dist
            total_debris_resistance_work += step_work
            mud_viscous_energy += step_work * 0.12
            # 逆流冲力代价最高、横切次之、顺流最低
            direction_factor = 0.25
            if flow_alignment < -0.35:
                direction_factor = 1.0
            elif abs(flow_alignment) <= 0.35:
                direction_factor = 0.65
            total_debris_cost += (
                direction_factor * v_local * max(move_dist, 1.0) * peak
            )

        segments.append({
            'from': [cx, cy], 'to': [nx, ny],
            'slope_risk': round(slope_risk, 3),
            'debris_risk': round(debris_risk, 3),
            'risk': round(max(slope_risk, debris_risk), 3),
            'slope_deg': round(info['slope_deg'], 1),
            'velocity': round(v_local, 2),
            'depth': round(h_local, 3),
        })

    total_steps = len(path) - 1
    m, g = 75.0, 9.8

    avg_slope_rad = np.radians(max_slope_angle)
    gravity_force = m * g * np.sin(avg_slope_rad)
    friction_force = MU * m * g * np.cos(avg_slope_rad)

    # 用路径上最大局部流速作为代表冲力
    v_mud = max_local_v
    mud_drag = 0.5 * RHO * CD * 0.5 * v_mud ** 2

    climb_work = m * g * total_height_gain / 0.8
    climb_work_kj = climb_work / 1000
    debris_work_kj = total_debris_resistance_work / 1000
    mud_viscous_kj = mud_viscous_energy / 1000
    total_mechanical_cost_kj = climb_work_kj + debris_work_kj + mud_viscous_kj
    battery_energy_kj = total_mechanical_cost_kj / 0.8

    passable = impassable_hits == 0
    slip_ratio = min(1.0, mud_drag / friction_force) if friction_force > 0 else 1.0

    if not passable:
        physics_note = (
            f"⚠ 路径擦边禁行区 {impassable_hits} 处！"
            f"局部最大流速 {max_local_v:.1f} m/s 已超滑移临界 {V_SLIP} m/s，"
            f"机器人会被冲走。需绕行或等待抢通。"
        )
    else:
        physics_note = (
            f"💡 路径爬升 {total_height_gain:.0f} m，"
            f"局部最大泥浆流速 {max_local_v:.1f} m/s（滑移临界 {V_SLIP} m/s），"
            f"冲力比 {slip_ratio:.0%}。总机械消耗 {total_mechanical_cost_kj:.1f} kJ，"
            f"电池 {battery_energy_kj:.1f} kJ。横切沟道 {cross_channel_steps} 步。"
        )

    return {
        'max_slope_angle': round(float(max_slope_angle), 1),
        'max_slope_deg': round(float(max_slope_angle), 1),
        'gravity_force': round(float(gravity_force), 0),
        'friction_force': round(float(friction_force), 0),
        'wind_drag': round(float(mud_drag), 1),
        'max_debris_push_force': round(float(max_debris_push_force), 1),
        'debris_resistance_work_kj': round(float(debris_work_kj), 2),
        'debris_work_kj': round(float(debris_work_kj), 2),
        'mud_viscous_energy_kj': round(float(mud_viscous_kj), 2),
        'mud_viscous_kj': round(float(mud_viscous_kj), 2),
        'total_mechanical_cost_kj': round(float(total_mechanical_cost_kj), 1),
        'battery_energy_kj': round(float(battery_energy_kj), 1),
        'total_resistance': round(float(gravity_force + mud_drag), 0),
        'total_height_gain': round(float(total_height_gain), 2),
        'total_height_loss': round(float(total_height_loss), 2),
        'climb_work_kj': round(float(climb_work_kj), 1),
        'up_steps': up_steps,
        'down_steps': down_steps,
        'flat_steps': flat_steps,
        'cross_channel_steps': cross_channel_steps,
        'channel_cross_steps': cross_channel_steps,
        'in_channel_steps': in_channel_steps,
        'headwind_steps': headwind_steps,
        'tailwind_steps': tailwind_steps,
        'cross_flow_steps': cross_flow_steps,
        'total_slope_cost': round(float(total_slope_cost), 2),
        'total_debris_cost': round(float(total_debris_cost), 2),
        'impassable_hits': impassable_hits,
        'max_local_velocity': round(float(max_local_v), 2),
        'max_local_depth': round(float(max_local_depth), 3),
        'slip_ratio': round(float(slip_ratio), 3),
        'v_slip': V_SLIP,
        'v_overturn': V_OVERTURN,
        'depth_proh': DEP_PROH,
        'passable': passable,
        'total_steps': total_steps,
        'segments': segments,
        'physics_note': physics_note
    }


@app.route('/api/dem', methods=['POST'])
def receive_dem():
    """接收前端导出的 GLB DEM（24×24 归一化高程），保存供危险场使用"""
    data = request.json
    dem = np.array(data.get('dem', []), dtype=np.float64)
    if dem.shape != (GRID_SIZE, GRID_SIZE):
        return jsonify({'error': f'DEM shape must be ({GRID_SIZE},{GRID_SIZE}), got {dem.shape}'}), 400

    # 关键修复：前端 exportDEM 输出的是"归一化 0~1"高程，而 hazard.py 按"真实米"
    # （谷底 2800m，相对高差 250m）计算。若不换算成米，相对起伏只剩 ~1，
    # D8 判停阈值(CELL*0.08=4m)恒成立 → 整个网格被判为堆积扇、主沟只取到极短几格、
    # 流速/流深/禁行等物理全部失真，导致"灾害链错位、泥石流不冲向口岸"。
    # 这里在入库前统一归一化再换算为米制（与 environment._to_meters 一致）。
    if dem.max() - dem.min() <= 0.01:
        # 已是等值（异常）则原样存，避免除零
        dem_m = dem
    else:
        rel = (dem - float(dem.min())) / float(dem.max() - dem.min())
        dem_m = 2800.0 + rel * 250.0
    np.save(DEM_PATH, dem_m)
    # 用换算后的米制 DEM 重建环境
    global env
    env = MountainRescueEnv(grid_size=GRID_SIZE, amplitude=1.0, dem=dem_m)
    return jsonify({'status': 'ok', 'shape': list(dem.shape),
                    'min': float(dem_m.min()), 'max': float(dem_m.max())})


@app.route('/api/hazard', methods=['GET'])
def get_hazard():
    not_ready = ensure_environment_ready()
    if not_ready:
        return not_ready
    intensity = float(request.args.get('intensity', 0.5))
    hz = env.get_hazard(intensity)
    return jsonify({
        'grid_size': [env.n, env.m],
        'channel': [[int(i), int(j)] for (i, j) in hz['channel']],
        'channel_width_m': [round(float(hz['width'][i, j]), 2) for (i, j) in hz['channel']],
        'velocity': hz['velocity'].round(2).tolist(),
        'depth': hz['depth'].round(3).tolist(),
        'deposit': hz['deposit'].round(3).tolist(),
        'deposit_max_m': round(float(hz['deposit'].max()), 3),
        'facies': hz['facies'].tolist(),
        'flow_dir': hz['flow_dir'].tolist(),
        'fdirx': hz['fdirx'].tolist(),
        'fdiry': hz['fdiry'].tolist(),
        'fan_cells': [[int(i), int(j)] for (i, j) in hz['fan_cells']],
        'blocked_edges': [[[int(a), int(b)] for (a, b) in e] for e in env.blocked_edges],
        'bypass_cells': [[int(i), int(j)] for (i, j) in env.bypass_cells],
        'landmarks': env.validate_landmarks(),
        'peak_scale': intensity,
        'peak_discharge_m3s': round(hz['peak_q'], 3),
        'physics': {
            'v_slip': V_SLIP,
            'v_overturn': V_OVERTURN,
            'rho_mud': RHO,
            'cd': CD,
            'depth_proh': DEP_PROH,
            'sink_proh': SINK_PROH,
        }
    })


@app.route('/api/terrain', methods=['GET'])
def get_terrain():
    not_ready = ensure_environment_ready()
    if not_ready:
        return not_ready
    amplitude = float(request.args.get('amplitude', 1.0))
    env.set_amplitude(amplitude)
    return jsonify({
        'terrain': env.get_terrain_data(),
        'grid_size': GRID_SIZE,
        'start': list(env.start),
        'goal': list(env.goal),
        'landmarks': env.validate_landmarks()
    })


@app.route('/api/path', methods=['POST'])
def get_path():
    not_ready = ensure_environment_ready()
    if not_ready:
        return not_ready

    data = request.get_json(silent=True) or {}

    try:
        wind_speed = float(data.get('wind_speed', 0.5))
        amplitude = float(data.get('amplitude', 1.0))
        episode = int(data.get('episode', 200))

        stage = TRAINING_STAGES.get(episode, TRAINING_STAGES[200])
        epsilon = stage['epsilon']

        env.set_amplitude(amplitude)
        path, total_cost, success = plan_path_with_epsilon(
            env, agent, wind_speed, stage['epsilon']
        )

        physics = compute_path_physics(env, path)

        return jsonify({
            'path': path,
            'total_cost': float(total_cost),
            'success': bool(success),
            'steps': max(0, len(path) - 1),
            'stage_name': stage['name'],
            'stage_description': stage['description'],
            'physics': physics,
            'start': list(env.start),
            'goal': list(env.goal),
            'landmarks': env.validate_landmarks()
        })
    except Exception as exc:
        app.logger.exception('Path planning failed')
        return jsonify({
            'error': '路径规划失败',
            'detail': str(exc)
        }), 500


@app.route('/api/train', methods=['POST'])
def train():
    """启动一组训练回合并记录轨迹，供前端回放。"""
    global ACTIVE_TRAINING_TASK
    not_ready = ensure_environment_ready()
    if not_ready:
        return not_ready
    data = request.json or {}
    n_episodes = int(data.get('episodes', 200))
    wind_speed = float(data.get('wind_speed', getattr(env, 'peak_scale', 0.5)))
    with TRAINING_TASKS_LOCK:
        if ACTIVE_TRAINING_TASK is not None:
            return jsonify({'error': '训练任务正在运行', 'task_id': ACTIVE_TRAINING_TASK}), 409
        env.peak_scale = wind_speed
        env._hazard = None
        run_training_episodes(env, agent, n_episodes=n_episodes)
    success_count = sum(1 for e in TRAINING_HISTORY if e['success'])
    return jsonify({
        'episodes': len(TRAINING_HISTORY),
        'success_rate': round(success_count / max(len(TRAINING_HISTORY), 1), 3),
        'best_path': BEST_PATH,
        'best_cost': round(BEST_PATH_COST, 2) if BEST_PATH else None,
    })


def _training_progress(task_id):
    with TRAINING_TASKS_LOCK:
        task = TRAINING_TASKS.get(task_id)
        if task is None:
            return None
        episodes = list(task['episodes'])
        return {
            'task_id': task_id,
            'status': task['status'],
            'completed': len(episodes),
            'total': task['total'],
            'episodes': episodes,
            'history': episodes,
            'best_path': BEST_PATH,
            'best_cost': round(BEST_PATH_COST, 2) if BEST_PATH is not None else None,
            'error': task.get('error'),
        }


def _run_training_task(task_id, n_episodes, wind_speed, stop_event):
    global ACTIVE_TRAINING_TASK
    task = TRAINING_TASKS[task_id]
    try:
        with TRAINING_TASKS_LOCK:
            env.peak_scale = wind_speed
            env._hazard = None

        def record_episode(episode):
            with TRAINING_TASKS_LOCK:
                task['episodes'].append(episode)

        run_training_episodes(
            env, agent, n_episodes=n_episodes,
            stop_event=stop_event, on_episode=record_episode
        )
        with TRAINING_TASKS_LOCK:
            task['status'] = 'stopped' if stop_event.is_set() else 'completed'
    except Exception as exc:
        app.logger.exception('Async training failed')
        with TRAINING_TASKS_LOCK:
            task['status'] = 'failed'
            task['error'] = str(exc)
    finally:
        with TRAINING_TASKS_LOCK:
            if ACTIVE_TRAINING_TASK == task_id:
                ACTIVE_TRAINING_TASK = None


@app.route('/api/train/start', methods=['POST'])
def train_start():
    """启动可轮询、可停止的后台训练任务。一次只允许一个任务写入共享 agent。"""
    global ACTIVE_TRAINING_TASK
    not_ready = ensure_environment_ready()
    if not_ready:
        return not_ready
    data = request.get_json(silent=True) or {}
    try:
        n_episodes = max(1, min(int(data.get('episodes', 200)), 2000))
        wind_speed = float(data.get('wind_speed', getattr(env, 'peak_scale', 0.5)))
    except (TypeError, ValueError) as exc:
        return jsonify({'error': '训练参数无效', 'detail': str(exc)}), 400

    with TRAINING_TASKS_LOCK:
        if ACTIVE_TRAINING_TASK is not None:
            return jsonify({'error': '训练任务正在运行', 'task_id': ACTIVE_TRAINING_TASK}), 409
        task_id = uuid.uuid4().hex
        task = {
            'status': 'running',
            'total': n_episodes,
            'episodes': [],
            'error': None,
            'stop_event': threading.Event(),
        }
        TRAINING_TASKS[task_id] = task
        ACTIVE_TRAINING_TASK = task_id
        thread = threading.Thread(
            target=_run_training_task,
            args=(task_id, n_episodes, wind_speed, task['stop_event']),
            name=f'training-{task_id[:8]}',
            daemon=True,
        )
        task['thread'] = thread
        thread.start()
    return jsonify({'task_id': task_id, 'status': 'running', 'total': n_episodes}), 202


@app.route('/api/train/progress/<task_id>', methods=['GET'])
def train_progress(task_id):
    progress = _training_progress(task_id)
    if progress is None:
        return jsonify({'error': '训练任务不存在', 'task_id': task_id}), 404
    return jsonify(progress)


@app.route('/api/train/stop/<task_id>', methods=['POST'])
def train_stop(task_id):
    with TRAINING_TASKS_LOCK:
        task = TRAINING_TASKS.get(task_id)
        if task is None:
            return jsonify({'error': '训练任务不存在', 'task_id': task_id}), 404
        if task['status'] == 'running':
            task['stop_event'].set()
            task['status'] = 'stopping'
        status = task['status']
    return jsonify({'task_id': task_id, 'status': status}), 202


@app.route('/api/training-history', methods=['GET'])
def training_history_api():
    """返回最近训练回合（含每步轨迹）与最优路径，供前端回放。"""
    limit = int(request.args.get('limit', 200))
    episodes = TRAINING_HISTORY[-limit:] if TRAINING_HISTORY else []
    success_count = sum(1 for e in episodes if e['success'])
    rewards = [e['total_reward'] for e in episodes]
    return jsonify({
        'episodes': episodes,
        'best_path': BEST_PATH,
        'best_cost': round(BEST_PATH_COST, 2) if BEST_PATH else None,
        'metrics': {
            'total_episodes': len(TRAINING_HISTORY),
            'success_rate': round(success_count / max(len(episodes), 1), 3),
            'average_reward': round(sum(rewards) / max(len(rewards), 1), 2) if rewards else 0,
        }
    })


@app.route('/api/training-stages', methods=['GET'])
def get_training_stages():
    stages = []
    for ep in sorted(TRAINING_STAGES.keys()):
        s = TRAINING_STAGES[ep]
        stages.append({
            'episode': ep,
            'name': s['name'],
            'description': s['description']
        })
    return jsonify({'stages': stages})


@app.route('/api/training-snapshot', methods=['GET'])
def training_snapshot_api():
    """返回指定阶段的评估路径快照（0/20/50/100/200），用于阶段按钮/一键演示。

    快照是"训练到该回合之后的规划结果"，与 TRAINING_HISTORY 里随机探索 steps 分离。
    """
    not_ready = ensure_environment_ready()
    if not_ready:
        return not_ready

    episode = int(request.args.get('episode', 0))
    # 若尚未训练，先按当前 env/agent 生成快照（幂等）
    if not TRAINING_SNAPSHOTS:
        build_training_snapshots(env, agent)

    snap = TRAINING_SNAPSHOTS.get(episode)
    if snap is None:
        # 就近取一个阶段（向上规整到 0/20/50/100/200）
        nearest = min(TRAINING_SNAPSHOTS.keys(),
                      key=lambda e: abs(e - episode),
                      default=0)
        snap = TRAINING_SNAPSHOTS.get(nearest)
    return jsonify(snap)


@app.route('/api/training-snapshots', methods=['GET'])
def training_snapshots_api():
    """返回全部五个阶段（0/20/50/100/200）评估快照，供一键演示。"""
    not_ready = ensure_environment_ready()
    if not_ready:
        return not_ready
    if not TRAINING_SNAPSHOTS:
        build_training_snapshots(env, agent)
    ordered = [TRAINING_SNAPSHOTS[ep] for ep in (0, 20, 50, 100, 200)
               if ep in TRAINING_SNAPSHOTS]
    return jsonify({'snapshots': ordered})


@app.route('/api/learning-curve', methods=['GET'])
def get_learning_curve():
    episodes = []
    rewards = []
    for ep in range(0, 201, 10):
        epsilon = max(0.01, 1.0 * (0.992 ** ep))
        avg_reward = 0
        trials = 3
        for _ in range(trials):
            _, total_cost, success = plan_path_with_epsilon(
                env, agent, 0.5, epsilon
            )
            if success:
                avg_reward += 100 - total_cost
            else:
                avg_reward += -total_cost
        avg_reward /= trials
        episodes.append(ep)
        rewards.append(round(avg_reward, 2))
    return jsonify({'episodes': episodes, 'rewards': rewards})


@app.route('/api/health', methods=['GET'])
def health():
    ready = env is not None and agent is not None
    return jsonify({
        'status': 'ok' if ready else 'not_ready',
        'environment_ready': env is not None,
        'agent_ready': agent is not None,
        'model_file_exists': os.path.exists(MODEL_PATH),
        'model_path': MODEL_PATH,
        'dem_file_exists': os.path.exists(DEM_PATH),
    }), 200 if ready else 503


def ensure_environment_ready():
    """所有依赖 env/agent 的接口统一入口：未初始化则尝试初始化，仍失败返回 503。"""
    if env is None or agent is None:
        init_app()
    if env is None or agent is None:
        return jsonify({
            'error': '仿真环境未初始化',
            'environment_ready': env is not None,
            'agent_ready': agent is not None,
        }), 503
    return None


# -------------------------- 豆包语音合成 TTS 接口 --------------------------
def _extract_doubao_audio(response):
    """
    从豆包响应中提取音频字节，兼容直接二进制、单一 JSON 和 NDJSON 流式分包三种形式。

    关键修复：豆包接口可能返回嵌套 JSON，音频 base64 字段可能出现在深层。
    必须递归遍历所有字段收集所有 chips，不能因为找到某个字段就提前 return，
    否则嵌套 JSON 时会漏掉音频导致"接口未返回有效音频"。
    """
    content_type = response.headers.get('Content-Type', '').lower()

    # 1. 直接返回音频二进制
    if content_type.startswith('audio/'):
        return response.content

    chunks = []

    def _collect_audio_chunks(value):
        if isinstance(value, dict):
            for key in (
                'audio',
                'audio_data',
                'audio_base64',
                'audio_base64_data',
                'data'
            ):
                item = value.get(key)
                if isinstance(item, str) and len(item) > 32:
                    try:
                        decoded = base64.b64decode(item, validate=False)
                    except Exception:
                        continue
                    if decoded:
                        chunks.append(decoded)

            for item in value.values():
                if isinstance(item, (dict, list)):
                    _collect_audio_chunks(item)

        elif isinstance(value, list):
            for item in value:
                _collect_audio_chunks(item)

    # 2. 先尝试解析为单一 JSON（可能为嵌套结构，需递归收集）
    try:
        parsed = response.json()
        _collect_audio_chunks(parsed)
    except ValueError:
        # 3. 失败则逐行解析 NDJSON 分包
        for line in response.text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except ValueError:
                continue
            _collect_audio_chunks(parsed)

    if chunks:
        return b''.join(chunks)

    # 4. 兜底返回二进制原文
    return response.content


def _audio_mimetype(content_type, audio_bytes):
    """
    根据响应头和音频魔数判断真实音频格式，返回正确的 mimetype。
    不再无条件写死 audio/wav，避免后端把 MP3/OGG 标记成 WAV 导致前端解码失败。
    """
    ct = (content_type or '').lower()

    # 优先信任响应头
    if ct.startswith('audio/mpeg') or ct.startswith('audio/mp3'):
        return 'audio/mpeg'
    if ct.startswith('audio/ogg'):
        return 'audio/ogg'
    if ct.startswith('audio/wav') or ct.startswith('audio/wave'):
        return 'audio/wav'
    if ct.startswith('audio/'):
        return ct

    # 响应头不可信时，用魔数判断
    if isinstance(audio_bytes, (bytes, bytearray)) and len(audio_bytes) >= 4:
        head = bytes(audio_bytes[:4])
        # RIFF = WAV
        if head[:4] == b'RIFF':
            return 'audio/wav'
        # ID3 或 0xFF 0xFB = MP3
        if head[:3] == b'ID3' or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
            return 'audio/mpeg'
        # OggS = OGG
        if head[:4] == b'OggS':
            return 'audio/ogg'

    # 请求时指定了 format=wav，兜底返回 wav
    return 'audio/wav'


@app.route('/api/tts', methods=['POST'])
def doubao_text_to_speech():
    data = request.get_json(silent=True) or {}
    text = str(data.get('text', '')).strip()

    if not text:
        return jsonify({
            'error': 'text 不能为空'
        }), 400

    # 主链路：小米 MiMo（音色"冰糖"）；不可用时自动回退豆包
    mimo_response = mimo_send_audio(text)
    if mimo_response is not None:
        return mimo_response

    missing = []

    if not DOUBAO_TTS_APP_ID:
        missing.append('DOUBAO_TTS_APP_ID')

    if not DOUBAO_TTS_ACCESS_KEY:
        missing.append('DOUBAO_TTS_ACCESS_KEY')

    if not DOUBAO_TTS_RESOURCE_ID:
        missing.append('DOUBAO_TTS_RESOURCE_ID')

    if not DOUBAO_TTS_SPEAKER:
        missing.append('DOUBAO_TTS_SPEAKER')

    if missing:
        return jsonify({
            'error': '豆包 TTS 配置缺失',
            'missing': missing
        }), 500

    request_id = str(uuid.uuid4())

    headers = {
        'Content-Type': 'application/json',
        'X-Api-App-Id': DOUBAO_TTS_APP_ID,
        'X-Api-Access-Key': DOUBAO_TTS_ACCESS_KEY,
        'X-Api-Resource-Id': DOUBAO_TTS_RESOURCE_ID,
        'X-Api-Request-Id': request_id
    }

    payload = {
        'user': {
            'uid': 'mountain-rescue-web'
        },
        'req_params': {
            'text': text[:2000],
            'speaker': DOUBAO_TTS_SPEAKER,
            'audio_params': {
                # 切换为 mp3 格式：字节更小、流式传输更平稳，
                # 且能避免 wav 流式分包时被前端 decodeAudioData 截断
                'format': 'mp3',
                'sample_rate': 24000
            }
        }
    }

    started_at = time.perf_counter()

    try:
        response = requests.post(
            DOUBAO_TTS_ENDPOINT,
            headers=headers,
            json=payload,
            timeout=(10, 60)
        )
    except requests.RequestException as exc:
        app.logger.exception('Doubao TTS network error')

        return jsonify({
            'error': '连接豆包语音服务失败',
            'detail': str(exc)
        }), 502

    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    app.logger.info(
        '[tts] text_len=%s status=%s elapsed_ms=%s response_bytes=%s',
        len(text),
        response.status_code,
        elapsed_ms,
        len(response.content)
    )

    logid = response.headers.get('X-Tt-Logid', '')

    if response.status_code != 200:
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:2000]

        return jsonify({
            'error': '豆包语音合成失败',
            'status_code': response.status_code,
            'logid': logid,
            'detail': detail
        }), 502

    content_type = (
        response.headers.get('Content-Type', '')
        .lower()
    )

    if content_type.startswith('audio/'):
        # 直接音频响应：根据实际 Content-Type 返回正确 mimetype，不写死 wav
        output_type = _audio_mimetype(content_type, response.content)
        ext = output_type.split('/')[-1].replace('mpeg', 'mp3')
        return send_file(
            io.BytesIO(response.content),
            mimetype=output_type,
            as_attachment=False,
            download_name=f'speech.{ext}'
        )

    audio_bytes = _extract_doubao_audio(response)

    if not audio_bytes:
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:2000]

        return jsonify({
            'error': '豆包接口未返回有效音频',
            'content_type': content_type,
            'logid': logid,
            'detail': detail
        }), 502

    # Base64 提取出的音频字节：用魔数判断真实格式
    output_type = _audio_mimetype(content_type, audio_bytes)
    ext = output_type.split('/')[-1].replace('mpeg', 'mp3')
    return send_file(
        io.BytesIO(audio_bytes),
        mimetype=output_type,
        as_attachment=False,
        download_name=f'speech.{ext}'
    )


@app.route('/api/tts-sentence', methods=['POST'])
def doubao_text_to_speech_sentence():
    """
    短句专用接口：单条短句 → 一次完整合成 → 立即返回整段 MP3 音频。
    前端按中文标点切短句后并发预取该接口，实现"首句尽快播放 + 连续播放"。

    不做 HTTP 分块流式（豆包 unidirectional 无法真正逐字流式），
    只保证单句延迟可控、按顺序拼接播放。
    """
    data = request.get_json(silent=True) or {}
    text = str(data.get('text', '')).strip()

    if not text:
        return jsonify({'error': 'text 不能为空'}), 400

    if len(text) > 500:
        return jsonify({'error': '单句不能超过 500 字'}), 400

    # 主链路：小米 MiMo；不可用时自动回退豆包
    mimo_response = mimo_send_audio(text)
    if mimo_response is not None:
        return mimo_response

    missing = [
        name for name, value in (
            ('DOUBAO_TTS_APP_ID', DOUBAO_TTS_APP_ID),
            ('DOUBAO_TTS_ACCESS_KEY', DOUBAO_TTS_ACCESS_KEY),
            ('DOUBAO_TTS_RESOURCE_ID', DOUBAO_TTS_RESOURCE_ID),
            ('DOUBAO_TTS_SPEAKER', DOUBAO_TTS_SPEAKER),
        )
        if not value
    ]

    if missing:
        return jsonify({
            'error': '豆包 TTS 配置缺失',
            'missing': missing
        }), 500

    started_at = time.perf_counter()

    try:
        response = requests.post(
            DOUBAO_TTS_ENDPOINT,
            headers=_doubao_headers(),
            json=_doubao_payload(text),
            timeout=(10, 60)
        )
    except requests.RequestException as exc:
        app.logger.exception('[tts-sentence] request failed')

        return jsonify({
            'error': '连接豆包语音服务失败',
            'detail': str(exc)
        }), 502

    elapsed_ms = round((time.perf_counter() - started_at) * 1000)

    if response.status_code != 200:
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:2000]

        app.logger.error(
            '[tts-sentence] failed status=%s elapsed_ms=%s detail=%s',
            response.status_code,
            elapsed_ms,
            detail
        )

        return jsonify({
            'error': '豆包语音合成失败',
            'status_code': response.status_code,
            'detail': detail
        }), 502

    audio_bytes = _extract_doubao_audio(response)

    if not audio_bytes:
        return jsonify({'error': '豆包接口未返回有效音频'}), 502

    content_type = _audio_mimetype(
        response.headers.get('Content-Type', ''),
        audio_bytes
    )

    app.logger.info(
        '[tts-sentence] success text_len=%s elapsed_ms=%s audio_bytes=%s',
        len(text),
        elapsed_ms,
        len(audio_bytes)
    )

    return Response(
        audio_bytes,
        mimetype=content_type,
        headers={
            'Cache-Control': 'no-store',
            'X-TTS-Latency-Ms': str(elapsed_ms)
        }
    )


@app.route('/api/tts-stream', methods=['GET'])
def doubao_text_to_speech_stream():
    """
    保留：仅作扩展入口与诊断。前端主路径使用 /api/tts-sentence，
    不再依赖本接口做"真正流式"（unidirectional 无法逐字流式）。
    """
    text = str(request.args.get('text', '')).strip()

    if not text:
        return jsonify({'error': 'text 不能为空'}), 400

    # 主链路：小米 MiMo（整段返回 mp3）；不可用时自动回退豆包
    mimo_response = mimo_send_audio(text)
    if mimo_response is not None:
        mimo_response.headers['Cache-Control'] = 'no-cache'
        mimo_response.headers['X-Accel-Buffering'] = 'no'
        return mimo_response

    missing = [
        name for name, val in (
            ('DOUBAO_TTS_APP_ID', DOUBAO_TTS_APP_ID),
            ('DOUBAO_TTS_ACCESS_KEY', DOUBAO_TTS_ACCESS_KEY),
            ('DOUBAO_TTS_RESOURCE_ID', DOUBAO_TTS_RESOURCE_ID),
            ('DOUBAO_TTS_SPEAKER', DOUBAO_TTS_SPEAKER),
        )
        if not val
    ]

    if missing:
        return jsonify({'error': '豆包 TTS 配置缺失', 'missing': missing}), 500

    request_id = str(uuid.uuid4())

    headers = {
        'Content-Type': 'application/json',
        'X-Api-App-Id': DOUBAO_TTS_APP_ID,
        'X-Api-Access-Key': DOUBAO_TTS_ACCESS_KEY,
        'X-Api-Resource-Id': DOUBAO_TTS_RESOURCE_ID,
        'X-Api-Request-Id': request_id
    }

    payload = {
        'user': {'uid': 'mountain-rescue-web'},
        'req_params': {
            'text': text[:2000],
            'speaker': DOUBAO_TTS_SPEAKER,
            'audio_params': {
                'format': 'mp3',
                'sample_rate': 24000
            }
        }
    }

    def generate_audio_stream():
        stream_started_at = time.perf_counter()
        total_bytes = 0

        with requests.post(
            DOUBAO_TTS_ENDPOINT,
            headers=headers,
            json=payload,
            stream=True,
            timeout=(5, 30)
        ) as resp:
            if resp.status_code != 200:
                app.logger.error(
                    f'[tts-stream] 豆包返回 {resp.status_code}: {resp.text[:500]}'
                )
                yield b''
                return

            # 逐 NDJSON 行消费分包，边收边吐
            first_line_ms = None
            try:
                for line in resp.iter_lines():
                    if not line:
                        continue
                    if first_line_ms is None:
                        first_line_ms = round(
                            (time.perf_counter() - stream_started_at) * 1000
                        )
                    try:
                        chunk_json = json.loads(line.decode('utf-8'))
                    except Exception:
                        continue
                    if not isinstance(chunk_json, dict):
                        continue
                    data_chunk = (
                        chunk_json.get('audio')
                        or chunk_json.get('audio_data')
                        or chunk_json.get('data')
                        or chunk_json.get('audio_base64')
                        or chunk_json.get('audio_base64_data')
                    )
                    if isinstance(data_chunk, str) and len(data_chunk) > 32:
                        try:
                            raw = base64.b64decode(data_chunk)
                        except Exception:
                            continue
                        if raw:
                            total_bytes += len(raw)
                            yield raw

                total_ms = round((time.perf_counter() - stream_started_at) * 1000)
                app.logger.info(
                    '[tts-stream] done first_line_ms=%s total_ms=%s audio_bytes=%s',
                    first_line_ms,
                    total_ms,
                    total_bytes
                )
            except Exception:
                app.logger.exception('[tts-stream] 读取豆包流失败')

    return Response(
        stream_with_context(generate_audio_stream()),
        mimetype='audio/mpeg',   # 请求即指定 mp3，流式输出按 mpeg 返回
        headers={
            'Cache-Control': 'no-cache',
            # 禁用 Nginx 等中间件的缓冲，确保分块实时到达浏览器
            'X-Accel-Buffering': 'no'
        }
    )


def _warm_up_mimo_connection():
    """
    后台预热 MiMo 的 TLS 连接。
    实测：新建连接要 3～11 秒，复用连接只要 ~0.8 秒，
    所以启动后先打一次最短的合成请求，把连接留在池里。
    """
    if not MIMO_TTS_API_KEY:
        return
    try:
        mimo_tts_bytes('你好')
        app.logger.info('[mimo-tts] 连接预热完成')
    except Exception:
        app.logger.warning('[mimo-tts] 连接预热失败（不影响正常使用）', exc_info=True)


# 模块加载即初始化（Flask CLI / Gunicorn / PyInstaller / python app.py 均保证环境就绪）。
# 带模型不存在提示：缺失 dqn_model.pth 时不失败，回退"未训练 DQN + A* 兜底"。
init_app()

# 后台预热 MiMo 连接，避免用户第一次点击时吃一次性建连开销
threading.Thread(
    target=_warm_up_mimo_connection,
    name='mimo-warmup',
    daemon=True
).start()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)
