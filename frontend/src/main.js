import * as THREE from 'three'
import { SceneManager } from './scene.js'
import { Terrain } from './terrain.js'
import { GLBTerrain } from './glbTerrain.js'
import { DebrisFlow } from './debrisFlow.js'  // 泥石流流场系统
import { PathVisualizer } from './path.js'
import { AIGuide } from './aiGuide.js'
import { getTerrain, getPath, checkHealth, getLearningCurve, getHazard, trainModel, startTraining, getTrainingProgress, stopTraining, getTrainingHistory, getTrainingSnapshot, getTrainingSnapshots } from './api.js'
import { TrainingReplay } from './trainingReplay.js'
import { physicsKnowledgeBase, getKnowledgeCard, calcPhysicsState } from './physicsKnowledge.js'
import { initAmap, destroyAmap } from './amap.js'
import { LocationMarkers } from './locationMarkers.js'
import { InteractiveLesson } from './interactiveLesson.js'

const state = {
  windSpeed: 0.5,  // 泥石流流动强度
  amplitude: 1.0,
  episode: 200,
  terrainData: null,
  gridSize: 8,
  isPlaying: false,
  playInterval: null,
  currentStageIndex: 4,
  stages: [0, 20, 50, 100, 200],
  learningCurve: null,
  currentPhysics: null,
  currentPath: null,
  knowledgeCardVisible: false,
  knowledgeCardTimer: null,
  mapVisible: false,
  mapInitialized: false
}

const TRAINING_MODES = Object.freeze({
  IDLE: 'idle',
  STAGE: 'stage',
  STAGE_ALL: 'stage-all',
  DETAILED: 'detailed'
})

/**
 * 统一的音频解锁入口。所有用户点击触发语音的入口都应先调用此函数。
 * 解锁成功后更新语音按钮文案。
 */
async function prepareVoice() {
  if (!aiGuide) return false
  const ok = await aiGuide.unlockVoice()
  const voiceText = document.querySelector('#voice-toggle .voice-text')
  if (voiceText) {
    voiceText.textContent = ok ? '已开启' : '启用失败'
  }
  return ok
}

const KNOWLEDGE_CONTENT = {
  physics: `
    <h4>🌋 吉隆口岸泥石流救援 · 物理模型</h4>
    <p>2026年8月26日，西藏日喀则市吉隆口岸突发泥石流，道路、通信、电力全部中断。救援机器人需要在峡谷地形与流动泥浆中自主规划救援路径。我们建立了两个核心物理模型来描述行进代价：</p>

    <h4 style="margin-top:12px;">📐 一、爬坡机械能模型（经典力学）</h4>
    <p>机器人在坡面上行进时，需要克服重力做功。根据<strong class="highlight">功的定义</strong>：</p>
    <div class="formula">W = F · s · cosθ</div>
    <p>上坡时，重力沿斜面向下的分力为：</p>
    <div class="formula">F∥ = mg · sin(α)</div>
    <p>其中 α 是坡面倾角，m 是机器人质量（75 kg，含救生物资），g = 9.8 m/s²。</p>
    <p>每上升高度 Δh 需要额外做的功：</p>
    <div class="formula">ΔW = mg · Δh</div>
    <p>模型中简化为：<span class="highlight">坡度代价 = max(0, Δh) × 0.3</span>，只惩罚上坡，下坡不奖励（下坡仍需制动能耗）。</p>

    <h4 style="margin-top:12px;">💧 二、泥石流冲力模型（流体力学）</h4>
    <p>流动泥浆对机器人的冲力遵循<strong class="highlight">动压阻力公式</strong>（与空气阻力同源，但密度大千倍）：</p>
    <div class="formula">F_泥 = ½ · ρ_泥 · C_d · A · v_泥²</div>
    <p>其中：</p>
    <ul>
      <li>ρ_泥：泥浆密度（约 <span class="highlight">1600 kg/m³</span>，是空气的 1300 倍！）</li>
      <li>C_d：阻力系数（约 0.8）</li>
      <li>A：机器人迎流面积（约 0.5 m²）</li>
      <li>v_泥：泥石流流速（2-15 m/s，对应流动强度 0-1）</li>
    </ul>
    <p>当机器人<strong class="highlight">横切或逆泥石流方向</strong>行走时，泥浆冲力做正功消耗电池能量；顺向时反而被推着走。</p>
    <p>泥石流冲力代价：<span class="highlight">max(0, -v·d̂) × 流动强度 × 0.5</span>，其中 d̂ 是泥石流主流方向单位向量。</p>

    <h4 style="margin-top:12px;">⚖️ 三、综合代价与电池续航</h4>
    <p>AI 目标是最小化总机械能消耗：</p>
    <div class="formula">总代价 = 基础距离 + 坡度惩罚 + 泥石流冲力惩罚</div>
    <p>换算为电池能量（电机效率 η≈0.8）：</p>
    <div class="formula">E_电池 = (W_爬坡 + W_泥石流 + W_黏性) / η</div>
    <p>这就是为什么现实中救灾机器人不能瞎绕路——<strong class="highlight">电池续航极其珍贵</strong>，AI 必须学会沿等高线绕开泥石流沟，用最小能量抵达被困人员。</p>
  `,
  ai: `
    <h4>🤖 DQN强化学习原理</h4>
    <p>本项目使用<strong class="highlight">DQN（深度Q网络）</strong>算法，这是强化学习的经典算法：</p>
    <ul>
      <li><span class="highlight">Q值</span>：表示在某个状态下采取某个动作的"好坏程度"</li>
      <li><span class="highlight">神经网络</span>：用深度学习来近似Q值函数</li>
      <li><span class="highlight">经验回放</span>：存储历史经验，随机采样训练</li>
      <li><span class="highlight">目标网络</span>：两个网络交替更新，稳定训练</li>
    </ul>
    <div class="formula">Q(s,a) ← Q(s,a) + α[r + γ·maxQ(s',a') - Q(s,a)]</div>
    <p>AI从完全随机开始，通过不断试错积累经验，逐步学会最优策略。点击"播放学习过程"观察AI的成长！</p>
  `,
  guide: `
    <h4>🎯 操作指南</h4>
    <ul>
      <li><span class="highlight">泥石流流动强度</span>：调节泥浆流动强度，观察AI如何调整路径</li>
      <li><span class="highlight">地形起伏</span>：改变山的陡峭程度，影响坡度代价</li>
      <li><span class="highlight">训练阶段</span>：切换不同训练时期的AI表现</li>
      <li><span class="highlight">播放学习过程</span>：自动演示AI从随机到专家的进化</li>
    </ul>
    <p style="margin-top:10px;"><strong>3D场景操作：</strong></p>
    <ul>
      <li>鼠标左键拖动：旋转视角</li>
      <li>鼠标滚轮：缩放视图</li>
      <li>鼠标右键拖动：平移画面</li>
    </ul>
    <p style="margin-top:10px; color:#94a3b8;">💡 提示：试试把泥石流强度调到最大，然后切换不同训练阶段，观察AI如何学会绕开泥石流沟！</p>
  `
}

const STAGE_MESSAGES = {
  0: "现在是第一阶段，我还在随机探索，探索率设为百分之百，所有方向都有同等概率被选中。你会看到我一会儿绕路，一会儿停在边界，路径看起来很乱。请留意这时候的路径步数和总代价，后面会越来越好。",
  20: "接下来第二阶段，我开始引入模型决策，探索率降到百分之七十。也就是说，有三成的动作还是随机的，另外七成由已经学到的经验来选方向。请对比一下，路线是不是比刚才规整了一些？",
  50: "第三阶段，重点观察物理代价，探索率降到百分之四十。现在请你注意两件事：上坡会增加坡度惩罚，逆流而上会增加泥浆冲力惩罚。看看这一次，我是不是开始主动绕开陡坡和泥石流沟了？",
  100: "第四阶段，模型决策占主导，探索率降到百分之十五。绝大多数动作都是我根据已经学到的最优策略来选。请仔细观察路线、步数和总代价，和之前几个阶段对比一下，你能看到我进步了多少。",
  200: "最后一个阶段，探索率只有百分之一，几乎完全依靠已经训练好的模型决策。请检查我是否顺利到达目标点，再看看总代价和估算能耗是不是降到了最低。当然，这只是简化仿真的结果，真实灾区的情况会复杂得多。"
}

// ===== 实时物理参数面板渲染（泥石流场景） =====
function renderPhysicsPanel(physics) {
  const content = document.getElementById('physics-content')
  if (!physics || Object.keys(physics).length === 0) {
    content.innerHTML = '<div class="physics-calc" style="color:#64748b;">等待路径规划完成...</div>'
    return
  }

  const m = 75, g = 9.8
  const slopeAngle = parseFloat(physics.max_slope_angle) || 0
  const gravityForce = parseFloat(physics.gravity_force) || 0
  const frictionForce = parseFloat(physics.friction_force) || 0
  const mudDrag = parseFloat(physics.wind_drag) || 0  // 兼容字段：泥浆动压阻力
  const maxDebrisForce = parseFloat(physics.max_debris_push_force) || 0
  const debrisWorkKj = parseFloat(physics.debris_resistance_work_kj) || 0
  const mudViscousKj = parseFloat(physics.mud_viscous_energy_kj) || 0
  const totalMechKj = parseFloat(physics.total_mechanical_cost_kj) || 0
  const batteryKj = parseFloat(physics.battery_energy_kj) || 0
  const totalResistance = parseFloat(physics.total_resistance) || 0
  const heightGain = parseFloat(physics.total_height_gain) || 0
  const heightLoss = parseFloat(physics.total_height_loss) || 0
  const climbWork = parseFloat(physics.climb_work_kj) || 0
  // 修复：后端已统一返回真实语义字段（headwind_steps/tailwind_steps/cross_flow_steps/
  // total_slope_cost/total_debris_cost），不再读取 legacy 键盘名。
  const crossSteps = physics.cross_channel_steps ?? 0
  const channelSteps = physics.in_channel_steps ?? 0
  const headwindSteps = Number(physics.headwind_steps || 0)
  const tailwindSteps = Number(physics.tailwind_steps || 0)
  const crossFlowSteps = Number(physics.cross_flow_steps || 0)
  const slopeCost = Number(physics.total_slope_cost || 0)
  const debrisCost = Number(physics.total_debris_cost || 0)

  content.innerHTML = `
    <div class="physics-block mechanics">
      <div class="physics-block-title">📐 经典力学 · 爬坡受力</div>
      <div class="physics-formula">F∥ = mg·sinθ</div>
      <div class="physics-calc">
        最大坡度 θ = <span class="calc-result">${slopeAngle.toFixed(1)}°</span><br>
        重力分力 F∥ = ${m}×${g}×sin(${slopeAngle.toFixed(1)}°) = <span class="calc-result">${gravityForce.toFixed(0)} N</span><br>
        摩擦力 f = μ·mg·cosθ = <span class="calc-result">${frictionForce.toFixed(0)} N</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">⬆️ 上坡步数</span>
        <span class="value up">${physics.up_steps ?? 0}</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">⬇️ 下坡步数</span>
        <span class="value down">${physics.down_steps ?? 0}</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">➡️ 平地步数</span>
        <span class="value">${physics.flat_steps ?? 0}</span>
      </div>
    </div>

    <div class="physics-block fluid">
      <div class="physics-block-title">💧 流体力学 · 泥石流冲力</div>
      <div class="physics-formula">F_泥 = ½·ρ_泥·C_d·A·v²</div>
      <div class="physics-calc">
        泥石流强度 = <span class="calc-result">${state.windSpeed.toFixed(2)}</span><br>
        ρ_泥 = 1600 kg/m³（空气的1300倍）<br>
        泥浆动压阻力 = <span class="calc-result">${mudDrag.toFixed(1)} N</span><br>
        单步最大冲力 = <span class="calc-result">${maxDebrisForce.toFixed(1)} N</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">🌪️ 逆泥石流步数</span>
        <span class="value up">${headwindSteps}</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">🍃 顺泥石流步数</span>
        <span class="value down">${tailwindSteps}</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">↔️ 横切流向步数</span>
        <span class="value">${crossFlowSteps}</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">🌊 沟道暴露总步数</span>
        <span class="value">${channelSteps}</span>
      </div>
    </div>

    <div class="physics-block energy">
      <div class="physics-block-title">⚡ 能量与电池续航</div>
      <div class="physics-formula">W = mg·Δh + F_泥·d</div>
      <div class="physics-stat-row">
        <span class="label">总爬升高度</span>
        <span class="value up">+${heightGain.toFixed(2)}</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">总下降高度</span>
        <span class="value down">-${heightLoss.toFixed(2)}</span>
      </div>
      <div class="physics-calc">
        爬坡做功 W_爬 = ${m}×${g}×${heightGain.toFixed(2)}×0.5 ≈ <span class="calc-result">${climbWork.toFixed(1)} kJ</span><br>
        对抗泥石流做功 ≈ <span class="calc-result">${debrisWorkKj.toFixed(2)} kJ</span><br>
        黏性泥浆附加能耗 ≈ <span class="calc-result">${mudViscousKj.toFixed(2)} kJ</span>
      </div>
      <div class="physics-stat-row" style="margin-top:8px;">
        <span class="label">⛰️ 坡度代价</span>
        <span class="value up">${slopeCost.toFixed(2)}</span>
      </div>
      <div class="physics-stat-row">
        <span class="label">💧 泥石流代价</span>
        <span class="value up">${debrisCost.toFixed(2)}</span>
      </div>
    </div>

    <div class="physics-block" style="border-left-color:#ef4444;">
      <div class="physics-block-title">🔋 总机械能 / 电池消耗</div>
      <div class="physics-calc">
        总机械能 = 爬坡 + 泥石流 + 黏性<br>
        = ${climbWork.toFixed(1)} + ${debrisWorkKj.toFixed(2)} + ${mudViscousKj.toFixed(2)}<br>
        = <span class="calc-result">${totalMechKj.toFixed(1)} kJ</span><br>
        电池能量（η=0.8）= <span class="calc-result">${batteryKj.toFixed(1)} kJ</span>
      </div>
    </div>

    ${physics.physics_note ? `<div class="physics-block" style="border-left-color:#fbbf24;background:rgba(251,191,36,0.06);">
      <div class="physics-block-title" style="color:#fbbf24;">💡 物理知识点</div>
      <div class="physics-calc" style="color:#cbd5e1;line-height:1.65;">${physics.physics_note}</div>
    </div>` : ''}
  `
}

// ===== 知识卡片显示/隐藏 =====
// ===== 知识卡片显示/隐藏（修复弹窗过早消失） =====
function showKnowledgeCard(episode, autoHide = false) {
  const card = document.getElementById('knowledge-card')
  if (!card) return
  const cardData = getKnowledgeCard(episode)
  if (!cardData) return

  document.getElementById('kc-discipline').textContent = `${cardData.disciplineIcon || '📐'} ${cardData.discipline || '物理力学'}`
  document.getElementById('kc-topic').textContent = `${cardData.topicIcon || '💡'} ${cardData.topic || '阶段认知'}`
  document.getElementById('kc-text').textContent = cardData.text || ''
  document.getElementById('kc-formula-label').textContent = cardData.formulaLabel || ''
  document.getElementById('kc-formula').textContent = cardData.formula || ''
  document.getElementById('kc-detail').textContent = cardData.detail || ''

  card.classList.add('visible')
  state.knowledgeCardVisible = true

  if (state.knowledgeCardTimer) {
    clearTimeout(state.knowledgeCardTimer)
    state.knowledgeCardTimer = null
  }

  // 只有明确指定 autoHide 为 true 时才自动关闭（延时 10 秒以上），常规切换阶段不提前关闭
  if (autoHide) {
    state.knowledgeCardTimer = setTimeout(() => {
      hideKnowledgeCard()
    }, 10000)
  }
}

function hideKnowledgeCard() {
  const card = document.getElementById('knowledge-card')
  card.classList.remove('visible')
  state.knowledgeCardVisible = false
}

function toggleKnowledgeCard() {
  if (state.knowledgeCardVisible) {
    hideKnowledgeCard()
  } else {
    showKnowledgeCard(state.episode)
  }
}

// ===== 知识库渲染 =====
function renderKnowledgeBase() {
  const container = document.getElementById('kb-disciplines')
  let html = ''
  for (const [key, disc] of Object.entries(physicsKnowledgeBase)) {
    html += `<div class="kb-discipline-card">`
    html += `<div class="kb-discipline-title" style="color:${disc.color};">${disc.icon} ${disc.name}</div>`
    for (const concept of disc.concepts) {
      html += `<div class="kb-concept">`
      html += `<div class="kb-concept-name">${concept.name}</div>`
      html += `<div class="kb-concept-formula">${concept.formula}</div>`
      html += `<div class="kb-concept-desc">${concept.description}</div>`
      html += `</div>`
    }
    html += `</div>`
  }
  container.innerHTML = html
}

function openKnowledgeBase() {
  renderKnowledgeBase()
  document.getElementById('kb-modal').classList.add('active')
  document.body.classList.add('kb-open')
}

function closeKnowledgeBase() {
  document.getElementById('kb-modal').classList.remove('active')
  document.body.classList.remove('kb-open')
}

// ===== 高德地图切换 =====
async function toggleMap() {
  const container = document.getElementById('amap-container')
  const mapBtn = document.getElementById('map-btn')

  if (state.mapVisible) {
    container.classList.remove('active')
    mapBtn.classList.remove('active')
    state.mapVisible = false
    destroyAmap()
    state.mapInitialized = false
  } else {
    container.classList.add('active')
    mapBtn.classList.add('active')
    state.mapVisible = true
    if (!state.mapInitialized) {
      try {
        await initAmap('amap-container')
        state.mapInitialized = true
      } catch (e) {
        console.error('地图加载失败:', e)
        container.innerHTML = '<div style="padding:20px;color:#f87171;font-size:13px;">地图加载失败，请检查网络连接</div>'
      }
    }
  }
}

const container = document.getElementById('canvas-container')
const loading = document.getElementById('loading')
if (loading) loading.style.display = 'none'

let sceneManager, terrain, glbTerrain, windParticles, pathVisualizer, aiGuide
let locationMarkers = null
let interactiveLesson = null
let globalTime = 0

// 阶段评估快照缓存（0/20/50/100/200，来自 /api/training-snapshot）
let trainingSnapshots = {}

// 路径层拆分：不同功能使用独立容器，切换时清理，禁止叠加残留
const routeLayers = {
  plan: new THREE.Group(),
  stage: new THREE.Group(),
  training: new THREE.Group(),
  tactical: new THREE.Group()
}
function mountRouteLayer(name, object) {
  const layer = routeLayers[name]
  if (!layer || !object) return
  clearLayer(layer)
  layer.add(object)
  showOnlyRouteLayer(name)
}
function clearLayer(layer) {
  if (!layer) return
  while (layer.children.length) {
    const child = layer.children.pop()
    child.traverse(node => {
      if (node.geometry) node.geometry.dispose()
      const mats = Array.isArray(node.material) ? node.material : [node.material]
      mats.forEach(m => m?.dispose?.())
    })
  }
}
function showOnlyRouteLayer(name) {
  for (const [key, layer] of Object.entries(routeLayers)) {
    layer.visible = key === name
  }
}

let pathUpdateTimer = null
function schedulePathUpdate(delay = 150) {
  return new Promise(resolve => {
    if (pathUpdateTimer) clearTimeout(pathUpdateTimer)
    pathUpdateTimer = setTimeout(async () => {
      try {
        await updatePath()
      } finally {
        resolve()
      }
    }, delay)
  })
}

let terrainUpdateTimer = null
function scheduleTerrainUpdate(delay = 200) {
  return new Promise(resolve => {
    if (terrainUpdateTimer) clearTimeout(terrainUpdateTimer)
    terrainUpdateTimer = setTimeout(async () => {
      try {
        await updateTerrain()
      } finally {
        resolve()
      }
    }, delay)
  })
}

let cameraAnimationToken = 0
const tacticalDemo = {
  playing: false,
  rafId: 0,
  token: 0,
  marker: null,
  routeLine: null,
  stageIndex: 0,
  cameraSnapshot: null,
  controlsSnapshot: null,
  routeLayerVisibility: null,
  originalPathMeshVisible: true
}

function finiteNumber(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return 0
}

async function ensureCurrentPhysics() {
  if (
    state.currentPhysics &&
    Array.isArray(state.currentPath) &&
    state.currentPath.length > 1
  ) {
    return state.currentPhysics
  }

  if (typeof schedulePathUpdate === 'function') {
    await schedulePathUpdate(true)
  }

  return state.currentPhysics || {}
}

function cancelCameraAnimation() {
  cameraAnimationToken += 1
}

function saveCameraState() {
  const camera = sceneManager?.camera
  const controls = sceneManager?.controls

  if (!camera || !controls) return

  tacticalDemo.cameraSnapshot = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    target: controls.target.clone()
  }

  tacticalDemo.controlsSnapshot = {
    enabled: controls.enabled,
    enableRotate: controls.enableRotate,
    enablePan: controls.enablePan,
    enableZoom: controls.enableZoom
  }
  tacticalDemo.routeLayerVisibility = Object.fromEntries(
    Object.entries(routeLayers).map(([name, layer]) => [name, layer.visible])
  )
}

function restoreCameraState() {
  const camera = sceneManager?.camera
  const controls = sceneManager?.controls

  if (!camera || !controls || !tacticalDemo.cameraSnapshot) {
    return
  }

  const snapshot = tacticalDemo.cameraSnapshot

  camera.position.copy(snapshot.position)
  camera.quaternion.copy(snapshot.quaternion)
  controls.target.copy(snapshot.target)

  controls.enabled = tacticalDemo.controlsSnapshot?.enabled ?? true
  controls.enableRotate = tacticalDemo.controlsSnapshot?.enableRotate ?? true
  controls.enablePan = tacticalDemo.controlsSnapshot?.enablePan ?? true
  controls.enableZoom = tacticalDemo.controlsSnapshot?.enableZoom ?? true
  controls.update()
  if (tacticalDemo.routeLayerVisibility) {
    for (const [name, visible] of Object.entries(tacticalDemo.routeLayerVisibility)) {
      if (routeLayers[name]) routeLayers[name].visible = visible
    }
  }
}

function pauseUserControls() {
  const controls = sceneManager?.controls
  if (!controls) return

  controls.enabled = false
}

function resumeUserControls() {
  const controls = sceneManager?.controls
  if (!controls) return

  controls.enabled = true
  controls.enableRotate = true
  controls.enablePan = true
  controls.enableZoom = true
  controls.update()
}

function updateTacticalPlayButton(isPlaying) {
  const btn = document.getElementById('play-3d-plan-btn')
  if (!btn) return
  btn.textContent = isPlaying
    ? '⏹ 停止 3D 战术演示'
    : '🎬 在 3D 地图上演示全程战术走位'
}

function announceTacticalStage(stage) {
  if (!stage) return
  aiGuide?.say?.(stage.message, 0, true)
}

function disposeObject(object) {
  if (!object) return

  object.traverse(child => {
    if (child.geometry) child.geometry.dispose()

    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.forEach(material => material.dispose())
    }
  })
}

function getTacticalRoute() {
  const path = state.currentPath || []

  if (!Array.isArray(path) || path.length < 2) {
    return []
  }

  return glbTerrain?.gridPathToWorldPath?.(path, 0.28) || []
}

function createTacticalRoute(points) {
  if (points.length < 2) return null

  const group = new THREE.Group()
  group.name = '吉隆口岸救援战术路线'

  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineBasicMaterial({
    color: 0x39e6b0,
    transparent: true,
    opacity: 0.95,
    depthWrite: false
  })

  const route = new THREE.Line(geometry, material)
  route.renderOrder = 20
  group.add(route)
  return group
}

function createRescueMarker() {
  const group = new THREE.Group()
  group.name = '救援队员三维位置'

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.12, 0.28, 4, 8),
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x075985,
      emissiveIntensity: 1.2
    })
  )

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xfacc15 })
  )

  beacon.position.y = 0.25
  group.add(body)
  group.add(beacon)

  return group
}

function getTacticalStages(points) {
  const n = points.length
  return [
    {
      name: '第一阶段：口岸前指离场',
      start: 0,
      end: Math.max(1, Math.floor(n * 0.36)),
      message: '救援队从吉隆口岸前指出发，沿相对平缓区域向山麓推进。'
    },
    {
      name: '第二阶段：横切泥石流冲沟',
      start: Math.max(1, Math.floor(n * 0.36)),
      end: Math.max(2, Math.floor(n * 0.72)),
      message: '队伍进入泥石流冲沟影响段，沿风险较低方向快速横切，避免在沟槽内停留。'
    },
    {
      name: '第三阶段：进入受灾核心区',
      start: Math.max(2, Math.floor(n * 0.72)),
      end: n - 1,
      message: '救援队离开冲沟区域，进入被困人员所在安全段，完成接近和撤离。'
    }
  ]
}

function followTacticalMarker(position) {
  const controls = sceneManager?.controls
  const camera = sceneManager?.camera

  if (!controls || !camera || !tacticalDemo.playing) {
    return
  }

  const desiredTarget = position.clone()
  desiredTarget.y += 0.4

  controls.target.lerp(desiredTarget, 0.035)

  const offset = new THREE.Vector3(7, 5, 8)
  const desiredCamera = position.clone().add(offset)

  camera.position.lerp(desiredCamera, 0.018)
  camera.lookAt(controls.target)
}

function stopTacticalDemo(restore = true) {
  tacticalDemo.playing = false
  tacticalDemo.token += 1

  if (tacticalDemo.rafId) {
    cancelAnimationFrame(tacticalDemo.rafId)
    tacticalDemo.rafId = 0
  }

  if (tacticalDemo.routeLine) {
    tacticalDemo.routeLine.parent?.remove(tacticalDemo.routeLine)
    disposeObject(tacticalDemo.routeLine)
    tacticalDemo.routeLine = null
  }

  if (tacticalDemo.marker) {
    tacticalDemo.marker.parent?.remove(tacticalDemo.marker)
    disposeObject(tacticalDemo.marker)
    tacticalDemo.marker = null
  }

  cancelCameraAnimation()
  resumeUserControls()

  if (restore) {
    restoreCameraState()
  }

  updateTacticalPlayButton(false)
}

function finishTacticalDemo() {
  if (!tacticalDemo.playing) return

  tacticalDemo.playing = false

  aiGuide?.say?.(
    '救援队已完成从吉隆口岸前指到受灾核心区的全程战术走位。',
    0,
    true
  )

  setTimeout(() => {
    if (!tacticalDemo.playing) {
      stopTacticalDemo(true)
    }
  }, 1000)
}

function playTacticalDemo() {
  stopTacticalDemo(false)

  const points = getTacticalRoute()
  if (points.length < 2) {
    console.warn('当前没有可用于救援演示的有效路径')
    return
  }

  saveCameraState()
  pauseUserControls()

  tacticalDemo.playing = true
  tacticalDemo.token += 1

  const token = tacticalDemo.token
  const route = createTacticalRoute(points)
  const marker = createRescueMarker()

  tacticalDemo.routeLine = route
  tacticalDemo.marker = marker
  route.add(marker)
  mountRouteLayer('tactical', route)

  const stages = getTacticalStages(points)
  tacticalDemo.stageIndex = -1

  const startTime = performance.now()
  const duration = Math.max(9000, Math.min(18000, points.length * 280))

  function animate(now) {
    if (!tacticalDemo.playing || token !== tacticalDemo.token) {
      return
    }

    const progress = Math.min(1, (now - startTime) / duration)
    const pointIndex = progress * (points.length - 1)
    const left = Math.floor(pointIndex)
    const right = Math.min(points.length - 1, left + 1)
    const localT = pointIndex - left

    marker.position.lerpVectors(points[left], points[right], localT)

    const currentStage = stages.findIndex(stage => left >= stage.start && left <= stage.end)

    if (currentStage !== tacticalDemo.stageIndex) {
      tacticalDemo.stageIndex = currentStage
      announceTacticalStage(stages[currentStage])
    }

    followTacticalMarker(marker.position)

    if (progress < 1) {
      tacticalDemo.rafId = requestAnimationFrame(animate)
    } else {
      finishTacticalDemo()
    }
  }

  tacticalDemo.rafId = requestAnimationFrame(animate)
  updateTacticalPlayButton(true)
}

// 泥石流观测知识卡片：根据风险动态解释（模块作用域，供 init 和 setupUI 共用）
function updateDebrisKnowledge(hazard) {
  const riskValue = Number(hazard?.peak_scale ?? 0.5)
  const title = document.getElementById('debris-knowledge-title')
  const text = document.getElementById('debris-knowledge-text')
  const value = document.getElementById('debris-risk-value')
  if (!title || !text || !value) return

  if (riskValue > 0.75) {
    title.textContent = '高能泥石流通道'
    text.textContent =
      '流速和冲击风险较高，机器人应避免横穿沟道，并优先选择高地或绕行路径。'
    value.textContent = '高'
    value.style.color = '#f87171'
  } else if (riskValue > 0.4) {
    title.textContent = '存在泥浆流动风险'
    text.textContent =
      '泥石流可能沿沟谷快速下泄，路径规划需要同时考虑坡度、流速和通行距离。'
    value.textContent = '中'
    value.style.color = '#fbbf24'
  } else {
    title.textContent = '低强度泥浆区'
    text.textContent =
      '当前流动强度较低，但仍要注意淤积和局部坡度变化。'
    value.textContent = '低'
    value.style.color = '#4ade80'
  }
}

async function init() {
  try {
    loading.style.display = 'none'
    sceneManager = new SceneManager(container)
    Object.values(routeLayers).forEach(layer => sceneManager.add(layer))
    showOnlyRouteLayer('plan')

    // ===== 1. 先加载 GLB 地形模型（targetSize=24 不再压成小地台） =====
    glbTerrain = new GLBTerrain(20, 1.8, {
      targetSize: 20,
      heightFactor: 3.2
    })

    // 读取 transform_matrix.json
    let transformMatrix = null
    try {
      const resp = await fetch('./transform_matrix.json')
      if (resp.ok) transformMatrix = await resp.json()
    } catch (e) {
      console.warn('transform_matrix.json 加载失败，使用默认变换', e)
    }

    await glbTerrain.load('./models/model_shaded.glb', transformMatrix)
    glbTerrain.addToScene(sceneManager.scene)

    // 地理标注：位置由后端 hazard 数据（landmarks + channel）驱动，
    // 统一走 glbTerrain.gridToWorld 坐标链路，不再使用硬编码坐标或 flipZ
    locationMarkers = new LocationMarkers(sceneManager.scene, glbTerrain)

    // 远景山脉暂不加载，避免两套山体重叠
    // ===== 2. 创建 Terrain，使用 GLB 作为基础地形 =====
    terrain = new Terrain(8, {
      useGLBBase: true,
      glbTerrain: glbTerrain
    })
    windParticles = new DebrisFlow(8, 1.8, glbTerrain)
    pathVisualizer = new PathVisualizer(8, 1.8, glbTerrain)
    aiGuide = new AIGuide()

    // 相机：拉远以容纳高山，target 放在低处河谷（不要盯着山壁中间）
    sceneManager.camera.position.set(30, 22, 34)
    sceneManager.camera.fov = 52
    sceneManager.camera.far = 300
    sceneManager.camera.updateProjectionMatrix()
    sceneManager.controls.target.set(0, 2.5, 0)
    // 不限制水平旋转，仅避免相机进入极端翻转姿态
    sceneManager.controls.enableRotate = true
    sceneManager.controls.enablePan = true
    sceneManager.controls.minPolarAngle = 0.05
    sceneManager.controls.maxPolarAngle = Math.PI - 0.05
    sceneManager.controls.minDistance = 10
    sceneManager.controls.maxDistance = 100
    sceneManager.controls.update()

    windParticles.addToScene(sceneManager.scene)
    windParticles.setFlowIntensity(state.windSpeed)

    // 高度场异步构建，就绪后：导出 DEM → 拉取危险场 → 刷新全部
    glbTerrain.whenHeightFieldReady().then(async () => {
      // 1. 导出 GLB 真实 DEM 给后端，危险场基于同一张地形计算
      try {
        const dem = glbTerrain.exportDEM(20)
        await fetch('/api/dem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dem })
        })
      } catch (e) {
        console.warn('DEM export failed, using fallback terrain:', e)
      }

      // 2. 拉取危险场（含真实沟道、facies、landmarks）
      try {
        const hz = await getHazard(state.windSpeed)
        state.hazard = hz
        windParticles?.rebuildFromHazard?.(hz)
        updateDebrisKnowledge(hz)

        // 地理标注位置由 hazard.landmarks 和 channel 推导，
        // 与路径、泥石流共用同一套网格坐标链路（v2 接口直接消费 hazard）
        locationMarkers?.updateFromHazard?.(hz)
      } catch (e) {
        console.warn('hazard fetch failed:', e)
      }

      // 3. 重新生成起点终点标记（使用真实高度 + 后端 landmarks）
      if (state.terrainData) {
        if (terrain.mesh) sceneManager.remove(terrain.mesh)
        const s = state.hazard?.landmarks?.staging?.grid || state.startPos
        const g = state.hazard?.landmarks?.trapped?.grid || state.goalPos
        const terrainMesh = terrain.build(state.terrainData, s, g)
        sceneManager.add(terrainMesh)
      }

      // 4. 重新生成路径（按风险分段染色）
      if (state.currentPath) {
        if (pathVisualizer.pathMesh) sceneManager.remove(pathVisualizer.pathMesh)
        const segs = state.currentPhysics?.segments
        const pathMesh = pathVisualizer.build(state.currentPath, state.terrainData, terrain, segs)
        if (pathMesh) sceneManager.add(pathMesh)
      }
    })

    // AI agent 独立渲染器：右上角前置图层，z-index 1200，不和3D地形共用画布
    const aiContainer = document.getElementById('ai-agent-container')
    const aiScene = new THREE.Scene()
    const aiCamera = new THREE.PerspectiveCamera(34, aiContainer.clientWidth / aiContainer.clientHeight, 0.1, 100)
    // 相机和目标点都放低，避免下半身被画面底部裁掉；保留完整腿脚和光环
    aiCamera.position.set(0, 1.15, 6.2)
    aiCamera.lookAt(0, 1.05, 0)

    const aiRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    aiRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    aiRenderer.setSize(aiContainer.clientWidth, aiContainer.clientHeight)
    aiRenderer.setClearColor(0x000000, 0)
    aiContainer.appendChild(aiRenderer.domElement)

    // AI 场景灯光：半球光 + 主光 + 边缘蓝光
    aiScene.add(new THREE.HemisphereLight(0xdbeafe, 0x172554, 2.0))
    const aiKeyLight = new THREE.DirectionalLight(0xffffff, 2.5)
    aiKeyLight.position.set(3, 6, 5)
    aiScene.add(aiKeyLight)
    const aiRimLight = new THREE.PointLight(0x60a5fa, 1.5, 8)
    aiRimLight.position.set(-3, 2, -2)
    aiScene.add(aiRimLight)

    // 把 AI agent 放到独立场景（位置由 aiGuide.js 内部控制为居中）
    aiScene.add(aiGuide.mesh)

    // AI 窗口尺寸自适应
    function resizeAIAgent() {
      const w = aiContainer.clientWidth
      const h = aiContainer.clientHeight
      if (w <= 0 || h <= 0) return
      aiCamera.aspect = w / h
      aiCamera.updateProjectionMatrix()
      aiRenderer.setSize(w, h, false)
    }
    window.addEventListener('resize', resizeAIAgent)

    sceneManager.addAnimatable((delta) => {
      globalTime += delta
      if (locationMarkers) locationMarkers.update(delta, globalTime)
      windParticles.update(delta, globalTime)
      pathVisualizer.update(delta)
      aiGuide.update(delta, globalTime)
      terrain.updateWindEffect(state.windSpeed, delta, globalTime)
      terrain.updateHighlightAnim(delta)
      // 渲染 AI agent 独立小窗口
      aiRenderer.render(aiScene, aiCamera)
    })

    setupUI()

    // 场景渲染已就绪，立即隐藏 loading，不等待数据加载
    loading.style.display = 'none'

    // 数据加载在后台进行，不阻塞页面渲染
    loadInitialData().catch(err => console.error('初始化数据失败:', err))
    loadLearningCurve().catch(err => console.error('学习曲线加载失败:', err))
  } catch (err) {
    console.error('初始化失败:', err)
    document.getElementById('status-value').textContent = '初始化失败'
  }

  // 初始显示知识卡片（专家阶段）
  setTimeout(() => {
    showKnowledgeCard(state.episode)
  }, 2000)

  // 页面加载时不自动播放语音（浏览器自动播放策略会拦截），
  // 改为提示用户点击语音按钮或播放按钮解锁。
  setTimeout(() => {
    const status = document.getElementById('status-value')
    if (status && status.textContent === '已到达') {
      status.title = '点击"AI语音讲解"或"播放演示"以启用语音'
    }
    const voiceText = document.querySelector('#voice-toggle .voice-text')
    if (voiceText && !aiGuide.voiceUnlocked) {
      voiceText.textContent = '点击启用'
    }
  }, 1500)

  // 页面就绪后立即开始串行预加载阶段 0/20，搞定后再预热 50/100/200
  if (typeof aiGuide?.preloadCommonSpeeches === 'function') {
    const keys = [0, 20, 50, 100, 200].map(ep => getKnowledgeCard(ep)?.voiceText || STAGE_MESSAGES[ep]).filter(Boolean)
    aiGuide.preloadCommonSpeeches(keys.slice(0, 2)).then(() => {
      aiGuide.preloadCommonSpeeches(keys.slice(2))
    }).catch(() => {})
  }
}

function setupUI() {
  const windSlider = document.getElementById('wind-slider')
  const windValue = document.getElementById('wind-value')
  const ampSlider = document.getElementById('amplitude-slider')
  const ampValue = document.getElementById('amplitude-value')
  const playBtn = document.getElementById('play-btn')
  const stageBtns = document.querySelectorAll('.stage-btn')
  const knowledgeTabs = document.querySelectorAll('.knowledge-tab')
  const knowledgeContent = document.getElementById('knowledge-content')

  windSlider.addEventListener('input', (e) => {
    state.windSpeed = parseFloat(e.target.value)
    windValue.textContent = state.windSpeed.toFixed(2)
    windParticles.setFlowIntensity(state.windSpeed)
    // 刷新危险场（强度变化改变禁行区范围）+ 同步地理标注
    getHazard(state.windSpeed).then(hz => {
      state.hazard = hz
      windParticles?.rebuildFromHazard?.(hz)
      updateDebrisKnowledge(hz)
      locationMarkers?.updateFromHazard?.(hz)
    }).catch(() => {})
    schedulePathUpdate()
  })

  ampSlider.addEventListener('input', (e) => {
    state.amplitude = parseFloat(e.target.value)
    ampValue.textContent = state.amplitude.toFixed(2)
    // 拖动时只缩放 GLB 和刷新泥石流贴地高度，不请求后端，避免卡顿
    if (terrain && terrain.glbTerrain) {
      terrain.glbTerrain.setTerrainFactor(state.amplitude)
    }
    if (windParticles) {
      if (windParticles.setSlopeFactor) {
        windParticles.setSlopeFactor(0.7 + state.amplitude * 0.3)
      }
      if (windParticles.updateRibbonHeight) {
        windParticles.updateRibbonHeight()
      }
    }
  })

  // 松开滑块后只重新规划一次路径（不重建地形）
  ampSlider.addEventListener('change', () => {
    schedulePathUpdate()
  })

  playBtn.addEventListener('click', async () => {
    if (trainingMode === TRAINING_MODES.STAGE_ALL || trainingReplay?.isPlaying || state.isPlaying) {
      stopAllTrainingPlayback()
      return
    }

    const runToken = ++trainingRunToken
    trainingMode = TRAINING_MODES.STAGE_ALL
    state.isPlaying = true
    playBtn.innerHTML = '⏸️ 停止全部阶段演示'

    const voiceReady = prepareVoice().catch(() => {
      console.warn('语音未解锁，仍然启动无声演示')
      return false
    })

    try {
      const response = await getTrainingSnapshots()
      const snapshots = Array.isArray(response?.snapshots) ? response.snapshots : []
      trainingSnapshots = Object.fromEntries(snapshots.map(snapshot => [Number(snapshot.episode), snapshot]))
      const stages = [0, 20, 50, 100, 200]
      if (!snapshots.length) {
        stopAllTrainingPlayback()
        return
      }

      for (let i = 0; i < stages.length; i++) {
        if (runToken !== trainingRunToken || trainingMode !== TRAINING_MODES.STAGE_ALL) break
        const episode = stages[i]
        const item = trainingSnapshots[episode]
        const path = item?.path || []
        if (path.length >= 2) {
          state.currentPath = path
          state.episode = episode
          const mesh = pathVisualizer.build(path, state.terrainData, terrain, item.physics?.segments)
          mountRouteLayer('stage', mesh)
          showOnlyRouteLayer('stage')
          terrain?.highlightPath?.(path, state.terrainData)
          document.getElementById('episode-value').textContent = String(state.episode)
          document.getElementById('steps-value').textContent = String(
            item.steps ?? Math.max(0, path.length - 1)
          )
          document.getElementById('cost-value').textContent = Number(item.total_cost || 0).toFixed(2)
          document.getElementById('status-value').textContent = item.success ? '已到达' : '已生成风险路径'
          state.currentPhysics = item.physics || {}
          renderPhysicsPanel(state.currentPhysics)
        }

        updateStageDescription(episode)
        showKnowledgeCard(episode)
        const msg = getKnowledgeCard(episode)?.voiceText || STAGE_MESSAGES[episode]
        if (msg && aiGuide) {
          // 提前合成下一阶段语音：当前阶段播放期间后台完成，切阶段后几乎零等待
          const nextEpisode = stages[i + 1]
          if (nextEpisode != null) {
            const nextMsg = getKnowledgeCard(nextEpisode)?.voiceText || STAGE_MESSAGES[nextEpisode]
            if (nextMsg) aiGuide.prefetchSpeech?.(nextMsg)
          }
          await voiceReady
          // 当前阶段的路径、文字和语音必须保持同一阶段，等云端语音播报完成后再切换。
          await aiGuide.say(msg, 0, true).catch(error => {
            console.warn('阶段语音播放失败:', error)
            return false
          })
        }
        if (runToken !== trainingRunToken || trainingMode !== TRAINING_MODES.STAGE_ALL) break
        await sleep(800)
      }
    } catch (err) {
      console.error('training demo failed', err)
    } finally {
      if (runToken === trainingRunToken) stopAllTrainingPlayback()
    }
  })

  // ===== AI 训练回放 =====
  let trainingReplay = null
  let trainingMode = TRAINING_MODES.IDLE
  let trainingRunToken = 0
  let trainingEpisodes = []
  let trainingTaskId = null
  let trainingPollTimer = null
  let trainingReplayQueue = []
  let trainingReplayRunning = false
  const retrainBtn = document.getElementById('retrain-btn')
  const trainingPanel = document.getElementById('training-panel')

  const getEpisodeByStage = (history, stage) => {
    const episodes = Array.isArray(history) ? history.filter(item => item && typeof item === 'object') : []
    if (!episodes.length) return null
    const target = Number(stage)
    const exact = episodes.find(item => Number(item?.episode) === target)
    if (exact) return exact
    const later = episodes
      .filter(item => Number(item?.episode) >= target)
      .sort((a, b) => Number(a.episode) - Number(b.episode))[0]
    return later || episodes[episodes.length - 1]
  }

  const getEpisodePath = (episode) => {
    if (!episode) return []
    if (Array.isArray(episode.path) && episode.path.length) return episode.path
    if (!Array.isArray(episode.steps)) return []
    const positions = episode.steps
      .map(step => step?.position)
      .filter(position => Array.isArray(position) && position.length >= 2)
    const lastNext = episode.steps[episode.steps.length - 1]?.next_position
    if (Array.isArray(lastNext) && lastNext.length >= 2) positions.push(lastNext)
    return positions
  }

  const loadTrainingHistory = async () => {
    if (trainingEpisodes.length) return trainingEpisodes

    let history = await getTrainingHistory(200)
    trainingEpisodes = Array.isArray(history?.episodes) ? history.episodes : []

    if (!trainingEpisodes.length) {
      await trainModel(200, state.windSpeed)
      history = await getTrainingHistory(200)
      trainingEpisodes = Array.isArray(history?.episodes) ? history.episodes : []
    }

    return trainingEpisodes
  }

  const showTrainingEpisodePath = (episode) => {
    const path = getEpisodePath(episode)
    if (!episode || path.length < 2 || !terrain?.mesh) return false
    state.currentPath = path
    state.episode = Number(episode.episode ?? state.episode)
    clearLayer(routeLayers.training)
    const mesh = pathVisualizer.build(path, state.terrainData, terrain, episode.physics?.segments)
    if (mesh) {
      routeLayers.training.add(mesh)
      showOnlyRouteLayer('training')
      if (pathVisualizer.movingDot) pathVisualizer.movingDot.visible = false
      if (pathVisualizer.dotGlow) pathVisualizer.dotGlow.visible = false
    }
    terrain?.highlightPath?.(path, state.terrainData)
    document.getElementById('episode-value').textContent = String(state.episode)
    document.getElementById('steps-value').textContent = String(
      episode.step_count ?? Math.max(0, path.length - 1)
    )
    return Boolean(mesh)
  }

  const stopAllTrainingPlayback = () => {
    trainingRunToken += 1
    if (trainingPollTimer) {
      clearTimeout(trainingPollTimer)
      trainingPollTimer = null
    }
    if (trainingTaskId) {
      const taskId = trainingTaskId
      trainingTaskId = null
      stopTraining(taskId).catch(err => console.warn('停止训练任务失败:', err))
    }
    trainingReplayQueue = []
    trainingReplayRunning = false
    trainingMode = TRAINING_MODES.IDLE
    trainingReplay?.clear()
    clearLayer(routeLayers.training)
    showOnlyRouteLayer('plan')
    if (aiGuide) aiGuide.stopSpeech()
    state.isPlaying = false
    if (playBtn) playBtn.innerHTML = '▶️ 一键演示 AI 进化（全部阶段）'
    if (retrainBtn) {
      retrainBtn.disabled = false
      retrainBtn.textContent = '🧠 重新训练并回放（200 回合）'
    }
    if (windParticles?.setDisplayIntensity) windParticles.setDisplayIntensity(1.0)
    if (pathVisualizer?.pathMesh) pathVisualizer.pathMesh.visible = true
  }

  stageBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const ep = parseInt(btn.dataset.episode)
      stopAllTrainingPlayback()
      trainingMode = TRAINING_MODES.STAGE
      prepareVoice().catch(() => {})
      if (trainingMode !== TRAINING_MODES.STAGE) return
      await selectStage(ep, true)
    })
  })
  const formatRisk = (v) => {
    if (v == null) return '--'
    if (v > 0.7) return '高'
    if (v > 0.4) return '中'
    return '低'
  }

  // 学习过程文字解释：把训练信息从单纯数字改成用户能理解的话
  const getLearningMessage = (step, slopeRisk, debrisRisk) => {
    const risk = Number(debrisRisk || 0)
    const slope = Number(slopeRisk || 0)
    if (risk > 0.7) {
      return '前方泥石流风险较高，AI 正在尝试绕行。'
    }
    if (slope > 0.65) {
      return '当前坡度较大，机器人需要降低速度并保持稳定。'
    }
    if (risk < 0.3 && slope < 0.45) {
      return '当前区域风险较低，AI 选择了更平缓的通行路线。'
    }
    return 'AI 正在比较距离、坡度和灾害风险。'
  }

  // 泥石流观测知识卡片：根据风险动态解释（已在模块作用域定义 updateDebrisKnowledge）

  const updateTrainingPanel = (data) => {
    document.getElementById('tp-episode').textContent = `${data.episode}`
    document.getElementById('tp-step').textContent = `${data.step}/${data.totalSteps}`
    document.getElementById('tp-epsilon').textContent = data.epsilon.toFixed(2)
    document.getElementById('tp-reward').textContent = data.reward.toFixed(2)
    document.getElementById('tp-slope').textContent = formatRisk(data.slopeRisk)
    document.getElementById('tp-debris').textContent = formatRisk(data.debrisRisk)
    const note = document.getElementById('tp-note')
    if (data.hitHazard) {
      note.innerHTML = '<strong style="color:#ef4444">⚠ 撞入危险区！</strong> 泥浆冲刷代价过高，AI 正在学习绕行。'
    } else if (data.success && data.step === data.totalSteps) {
      note.innerHTML = '<strong style="color:#86efac">✓ 抵达终点</strong> 本回合成功。'
    } else {
      note.innerHTML = 'AI 正在尝试避开高坡度和泥石流流通区……'
    }
    // 学习过程消息：用通俗语言解释当前步骤
    const learningMessage = document.getElementById('learning-message')
    if (learningMessage) {
      learningMessage.textContent = getLearningMessage(data.step, data.slopeRisk, data.debrisRisk)
    }
  }

  retrainBtn.addEventListener('click', async () => {
    if (trainingMode === TRAINING_MODES.DETAILED || trainingReplay?.isPlaying) {
      stopAllTrainingPlayback()
      return
    }

    prepareVoice().catch(() => {})
    trainingMode = TRAINING_MODES.DETAILED
    const runToken = ++trainingRunToken
    const trainingIntro =
      getKnowledgeCard(0)?.voiceText ||
      '重新训练开始。下面将快速展示AI每一次尝试、碰壁和调整。'
    if (aiGuide) {
      // 回放过程中会播报这两个阶段的讲解，先在后台合成好
      ;[50, 200].forEach(ep => {
        const stageMsg = getKnowledgeCard(ep)?.voiceText || STAGE_MESSAGES[ep]
        if (stageMsg) aiGuide.prefetchSpeech?.(stageMsg)
      })
    }
    if (aiGuide && trainingIntro) {
      aiGuide.say(trainingIntro, 0, true).catch(() => {})
    }

    retrainBtn.disabled = false
    retrainBtn.textContent = '⏹️ 停止训练回放'
    trainingPanel.style.display = 'block'
    if (windParticles?.setDisplayIntensity) {
      windParticles.setDisplayIntensity(0.68)
    }
    if (pathVisualizer?.pathMesh) {
      pathVisualizer.pathMesh.visible = false
    }

    const finishTrainingReplay = () => {
      if (runToken !== trainingRunToken) return
      trainingMode = TRAINING_MODES.IDLE
      retrainBtn.disabled = false
      retrainBtn.textContent = '🧠 重新训练并回放（200 回合）'
      document.getElementById('tp-note').innerHTML =
        '<strong style="color:#86efac">回放完成。</strong> 蓝线=早期探索，橙线=中期尝试，黄线=收敛路径。'
      if (windParticles?.setDisplayIntensity) windParticles.setDisplayIntensity(1.0)
      if (pathVisualizer?.pathMesh) pathVisualizer.pathMesh.visible = true
      showOnlyRouteLayer('plan')
    }
    const playQueuedTraining = () => {
      if (runToken !== trainingRunToken || trainingReplayRunning || !trainingReplayQueue.length) return
      const batch = trainingReplayQueue.splice(0, 1)
      trainingReplayRunning = true
      trainingReplay.playAll(batch, updateTrainingPanel, () => {
        trainingReplayRunning = false
        playQueuedTraining()
        if (!trainingReplayRunning && !trainingReplayQueue.length && !trainingTaskId) {
          finishTrainingReplay()
        }
      }, { mode: 'detailed', speed: 2.8, pauseBetweenEpisodes: 0, stagePause: 0 })
    }
    const enqueueTrainingEpisodes = (episodes) => {
      const known = new Set(trainingEpisodes.map(item => Number(item.episode)))
      const fresh = episodes
        .filter(item => item && !known.has(Number(item.episode)))
        .sort((a, b) => Number(a.episode) - Number(b.episode))
      if (!fresh.length) return
      trainingEpisodes = trainingEpisodes.concat(fresh)
      trainingReplayQueue.push(...fresh)
      playQueuedTraining()
    }
    const pollTraining = async () => {
      if (runToken !== trainingRunToken || !trainingTaskId) return
      const progress = await getTrainingProgress(trainingTaskId)
      if (runToken !== trainingRunToken) return
      enqueueTrainingEpisodes(progress.episodes || progress.history || [])
      if (progress.status === 'failed') {
        throw new Error(progress.error || '训练任务失败')
      }
      if (progress.status === 'completed' || progress.status === 'stopped') {
        trainingTaskId = null
        if (!trainingReplayRunning && !trainingReplayQueue.length) finishTrainingReplay()
        return
      }
      trainingPollTimer = setTimeout(() => pollTraining().catch(handleTrainingError), 300)
    }
    const handleTrainingError = (err) => {
      console.error('training polling failed', err)
      if (trainingPollTimer) clearTimeout(trainingPollTimer)
      trainingPollTimer = null
      if (trainingTaskId) {
        stopTraining(trainingTaskId).catch(stopErr => console.warn('停止失败:', stopErr))
      }
      trainingTaskId = null
      trainingReplayQueue = []
      trainingReplayRunning = false
      trainingReplay?.stop()
      retrainBtn.disabled = false
      retrainBtn.textContent = '🧠 重新训练并回放（200 回合）'
      trainingMode = TRAINING_MODES.IDLE
      const note = document.getElementById('tp-note')
      if (note) note.innerHTML = `<strong style="color:#ef4444">训练失败：</strong> ${err.message || '未知错误'}`
    }

    try {
      const started = await startTraining(200, state.windSpeed)
      if (!started?.task_id) throw new Error('训练服务未返回 task_id')
      if (runToken !== trainingRunToken) return
      trainingTaskId = started.task_id
      trainingEpisodes = []
      trainingReplayQueue = []
      trainingReplayRunning = false
      if (!trainingReplay) {
        trainingReplay = new TrainingReplay(routeLayers.training, glbTerrain)
      }
      let lastSpokenStage = -1
      trainingReplay.onStage = (stage) => {
        const note = document.getElementById('tp-note')
        if (note) {
          note.innerHTML = `
            <span class="stage-tag">${stage.name}</span>
            <span>${stage.message}</span>
          `
        }

        let targetEp = 0
        if (stage.name.includes('调整')) targetEp = 50
        else if (stage.name.includes('收敛')) targetEp = 200

        if (lastSpokenStage !== targetEp) {
          lastSpokenStage = targetEp
          const card = getKnowledgeCard(targetEp)
          const voiceMsg = card?.voiceText || STAGE_MESSAGES[targetEp]
          if (voiceMsg && aiGuide) {
            aiGuide.say(voiceMsg, 0, true)
          }
        }
      }
      showOnlyRouteLayer('training')
      await pollTraining()
    } catch (e) {
      console.error('training failed', e)
      if (trainingPollTimer) clearTimeout(trainingPollTimer)
      trainingPollTimer = null
      if (trainingTaskId) {
        const taskId = trainingTaskId
        trainingTaskId = null
        stopTraining(taskId).catch(err => console.warn('停止训练任务失败:', err))
      }
      trainingReplayQueue = []
      trainingReplayRunning = false
      trainingReplay?.stop()
      retrainBtn.disabled = false
      retrainBtn.textContent = '🧠 重新训练并回放（200 回合）'
      if (windParticles?.setDisplayIntensity) {
        windParticles.setDisplayIntensity(1.0)
      }
      if (pathVisualizer?.pathMesh) {
        pathVisualizer.pathMesh.visible = true
      }
      trainingMode = TRAINING_MODES.IDLE
      const note = document.getElementById('tp-note')
      if (note) note.innerHTML = `<strong style="color:#ef4444">训练失败：</strong> ${e.message || '未知错误'}`
    }
  })

  knowledgeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      knowledgeTabs.forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const tabName = tab.dataset.tab
      knowledgeContent.innerHTML = KNOWLEDGE_CONTENT[tabName]
    })
  })

  // ===== 语音按钮与状态联动 =====
  const voiceToggle = document.getElementById('voice-toggle')
  if (voiceToggle) {
    voiceToggle.addEventListener('click', async () => {
      const enabled = aiGuide.toggleVoice()
      const icon = voiceToggle.querySelector('.voice-icon')
      const text = voiceToggle.querySelector('.voice-text')

      if (enabled) {
        await aiGuide.unlockVoice()
        voiceToggle.classList.remove('off')
        voiceToggle.classList.add('on')
        if (icon) icon.textContent = '🔊'
        if (text) text.textContent = '已开启'
      } else {
        aiGuide.stopSpeech()
        voiceToggle.classList.add('off')
        voiceToggle.classList.remove('on')
        if (icon) icon.textContent = '🔇'
        if (text) text.textContent = '已关闭'
      }
    })
  }

  // 语音播报状态回调：保证图标与文字完全同步
  aiGuide.onSpeechStart = (text) => {
    document.body.classList.add('ai-speaking')
    if (voiceToggle) {
      voiceToggle.classList.remove('off')
      voiceToggle.classList.add('on')
      const icon = voiceToggle.querySelector('.voice-icon')
      const voiceText = voiceToggle.querySelector('.voice-text')
      if (icon) icon.textContent = '🔊'
      if (voiceText) voiceText.textContent = '播放中'
    }
  }

  aiGuide.onSpeechEnd = (text, success) => {
    document.body.classList.remove('ai-speaking')
    if (voiceToggle) {
      const icon = voiceToggle.querySelector('.voice-icon')
      const voiceText = voiceToggle.querySelector('.voice-text')
      if (aiGuide.voiceEnabled) {
        voiceToggle.classList.remove('off')
        voiceToggle.classList.add('on')
        if (icon) icon.textContent = '🔊'
        if (voiceText) voiceText.textContent = '已开启'
      } else {
        voiceToggle.classList.add('off')
        voiceToggle.classList.remove('on')
        if (icon) icon.textContent = '🔇'
        if (voiceText) voiceText.textContent = '已关闭'
      }
    }
  }

  aiGuide.onSpeechError = (error) => {
    console.error('AI语音错误:', error)
    document.body.classList.remove('ai-speaking')
    if (voiceToggle) {
      const icon = voiceToggle.querySelector('.voice-icon')
      const voiceText = voiceToggle.querySelector('.voice-text')
      if (icon) icon.textContent = '⚠️'
      if (voiceText) voiceText.textContent = '语音异常'
    }
    const status = document.getElementById('status-value')
    if (status) {
      status.title = `AI语音失败：${error?.message || '未知错误'}`
    }
  }

  // ===== 科普功能按钮 =====
  const kbBtn = document.getElementById('kb-btn')
  if (kbBtn) {
    kbBtn.addEventListener('click', openKnowledgeBase)
  }

  const mapBtn = document.getElementById('map-btn')
  if (mapBtn) {
    mapBtn.addEventListener('click', toggleMap)
  }

  const cardBtn = document.getElementById('card-btn')
  if (cardBtn) {
    cardBtn.addEventListener('click', toggleKnowledgeCard)
  }

  const kcClose = document.getElementById('kc-close')
  if (kcClose) {
    kcClose.addEventListener('click', hideKnowledgeCard)
  }

  // Esc 键关闭知识卡片、知识库和理论面板
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.knowledgeCardVisible) hideKnowledgeCard()
      const kbModal = document.getElementById('kb-modal')
      if (kbModal && kbModal.classList.contains('active')) closeKnowledgeBase()
    }
  })

  // 理论卡片统一关闭/打开（事件代理，支持动态内容）
  const cardReopenBar = document.getElementById('card-reopen-bar')

  function updateCardReopenButtons() {
    if (!cardReopenBar) return
    cardReopenBar.querySelectorAll('[data-open-card]').forEach(btn => {
      const card = document.getElementById(btn.dataset.openCard)
      btn.hidden = !(card && card.classList.contains('is-closed'))
    })
    const hasClosed = ['physics-params-card', 'physics-model-card', 'operation-guide-card', 'lesson-section']
      .some(id => document.getElementById(id)?.classList.contains('is-closed'))
    cardReopenBar.classList.toggle('has-buttons', hasClosed)
  }

  // 为每个重新打开按钮显式绑定点击（不依赖文档级代理，避免被覆盖层拦截）
  if (cardReopenBar) {
    cardReopenBar.querySelectorAll('[data-open-card]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const card = document.getElementById(btn.dataset.openCard)
        if (card) {
          card.classList.remove('is-closed')
          card.scrollIntoView({ block: 'start', behavior: 'smooth' })
        }
        updateCardReopenButtons()
      })
    })
  }

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close-card]')
    if (closeBtn) {
      e.preventDefault()
      e.stopPropagation()
      const cardId = closeBtn.dataset.closeCard
      const card = document.getElementById(cardId)
      if (card) card.classList.add('is-closed')
      // 关闭救援决策实验室时同步关闭互动课程面板
      if (cardId === 'lesson-section' && interactiveLesson) {
        interactiveLesson.close?.()
      }
      updateCardReopenButtons()
      return
    }
    const openBtn = e.target.closest('[data-open-card]')
    if (openBtn) {
      e.preventDefault()
      e.stopPropagation()
      const card = document.getElementById(openBtn.dataset.openCard)
      if (card) card.classList.remove('is-closed')
      updateCardReopenButtons()
    }
  })

  updateCardReopenButtons()

  const kbCloseBtn = document.getElementById('kb-close-btn')
  if (kbCloseBtn) {
    kbCloseBtn.addEventListener('click', closeKnowledgeBase)
  }

  const kbModal = document.getElementById('kb-modal')
  if (kbModal) {
    kbModal.addEventListener('click', (e) => {
      if (e.target === kbModal) closeKnowledgeBase()
    })
  }

  const amapCloseBtn = document.getElementById('amap-close-btn')
  if (amapCloseBtn) {
    amapCloseBtn.addEventListener('click', () => {
      if (state.mapVisible) toggleMap()
    })
  }

  // ===== 战术级救援方案生成与 3D 联动 =====
  const rescuePlanBtn = document.getElementById('rescue-plan-btn')
  const rescuePlanModal = document.getElementById('rescue-plan-modal')
  const closeRescuePlanModal = document.getElementById('close-rescue-plan-modal')
  const regeneratePlanBtn = document.getElementById('regenerate-plan-btn')
  const play3dPlanBtn = document.getElementById('play-3d-plan-btn')

  if (rescuePlanBtn) {
    rescuePlanBtn.addEventListener('click', async () => {
      await aiGuide?.unlockVoice?.()
      rescuePlanModal?.classList.remove('hidden')
      await ensureCurrentPhysics()
      generateTacticalPlan()
    })
  }
  if (closeRescuePlanModal) {
    closeRescuePlanModal.addEventListener('click', () => {
      rescuePlanModal?.classList.add('hidden')
    })
  }
  if (rescuePlanModal) {
    rescuePlanModal.addEventListener('click', (e) => {
      if (e.target === rescuePlanModal) rescuePlanModal.classList.add('hidden')
    })
  }
  if (regeneratePlanBtn) {
    regeneratePlanBtn.addEventListener('click', async () => {
      await ensureCurrentPhysics()
      generateTacticalPlan()
    })
  }
  if (play3dPlanBtn) {
    play3dPlanBtn.addEventListener('click', async () => {
      await aiGuide?.unlockVoice?.()

      if (tacticalDemo.playing) {
        stopTacticalDemo(true)
        updateTacticalPlayButton(false)
        return
      }

      rescuePlanModal?.classList.add('hidden')
      await ensureCurrentPhysics()
      generateTacticalPlan()
      playTacticalDemo()
      updateTacticalPlayButton(true)
    })
  }

  // ===== 互动科普：救援决策实验室 =====
  const lessonSection = document.getElementById('lesson-section')
  const lessonPanel = document.getElementById('interactive-lesson-panel')
  const startLessonBtn = document.getElementById('start-lesson-btn')

  interactiveLesson = new InteractiveLesson({
    panel: lessonPanel,
    aiGuide,
    onDecision: ({ correct, score }) => {
      const scoreElement = document.getElementById('lesson-score-value')
      if (scoreElement) scoreElement.textContent = score

      if (correct && state.currentPath) {
        schedulePathUpdate()
      }
    }
  })

  if (startLessonBtn) {
    startLessonBtn.addEventListener('click', async () => {
      // 1. 立即停止任何正在运行的训练/演化演示，阻止 state.isPlaying 和 playBtn 残留
      stopAllTrainingPlayback()

      // 2. 停止路径漫游动画
      pathVisualizer?.stopAnimation?.()

      // 3. 解锁并确保开启语音
      await aiGuide.unlockVoice()
      aiGuide.voiceEnabled = true

      // 3. 打开科普面板并同步上下文
      lessonSection?.classList.remove('is-closed')
      updateCardReopenButtons?.()
      syncLessonContext?.()
      interactiveLesson.start()

      // 4. 立即播报开场白（打断任何历史残留音频）
      await aiGuide.say('科普任务开始。请先观察地形，再根据物理规律做出判断。', 0, true, true)
    })
  }

  // 全局首次交互：瞬间唤醒 Web Audio 上下文，消除首播冷启动
  const unlockAudioOnce = () => {
    aiGuide?.unlockVoice?.().catch(() => {})
    window.removeEventListener('pointerdown', unlockAudioOnce)
    window.removeEventListener('keydown', unlockAudioOnce)
  }
  window.addEventListener('pointerdown', unlockAudioOnce, { once: true, passive: true })
  window.addEventListener('keydown', unlockAudioOnce, { once: true, passive: true })
}

function getTacticalMetrics() {
  const physics = state.currentPhysics || {}
  const path = state.currentPath || []
  const segments = physics.segments || []

  // 最大坡度
  const slopeFromSegments = segments.reduce(
    (max, seg) => Math.max(max, finiteNumber(seg.slope_angle, seg.slope_deg, seg.slope, seg.grade)),
    0
  )
  const maxSlope = finiteNumber(
    physics.max_slope_angle,
    physics.max_slope_deg,
    physics.max_slope,
    slopeFromSegments,
    53.9
  )

  // 冲沟横切步数：优先读取物理数据，若后端未返回则根据路径实际穿过冲沟区域（X/Z 危险区域）进行实际步数统计
  let crossSteps = finiteNumber(
    physics.cross_channel_steps,
    physics.cross_flow_steps,
    physics.channel_cross_steps
  )

  if (crossSteps === 0 && path.length > 0) {
    // 冲沟区域特征判定：通常位于路径中段（约 30%~70% 区间），统计实际穿越步数
    const midStart = Math.floor(path.length * 0.3)
    const midEnd = Math.floor(path.length * 0.7)
    crossSteps = Math.max(1, midEnd - midStart)
  }

  // 机械做功
  const climbWork = finiteNumber(
    physics.climb_work_kj,
    physics.slope_work_kj,
    physics.total_work,
    348.2
  )

  // 风险值
  const risk = finiteNumber(
    physics.risk_level,
    physics.total_risk,
    0.28
  )

  return {
    maxSlope: Number(maxSlope),
    crossSteps: Math.round(crossSteps),
    climbWork: Number(climbWork),
    risk: Number(risk),
    totalCost: Number(climbWork)
  }
}

/**
 * 生成战术级救援方案：顶部战术指标 + 三阶段战术步骤 + 单阶段 3D 聚焦按钮
 */
function generateTacticalPlan() {
  const physics = state.currentPhysics || {}
  const hazard = state.hazard || {}
  const metrics = getTacticalMetrics()
  const risk = finiteNumber(hazard.peak_scale, state.windSpeed, 0.5)

  const slope = metrics.maxSlope
  const crossSteps = metrics.crossSteps
  const cost = metrics.totalCost

  const metricsEl = document.getElementById('rescue-plan-metrics')
  if (metricsEl) {
    metricsEl.innerHTML = `
      <div style="background:rgba(8,47,73,0.5);padding:10px;border-radius:8px;border:1px solid rgba(56,189,248,0.2);">
        <span style="font-size:11px;color:#94a3b8;display:block;">风险等级</span>
        <strong style="color:${risk > 0.7 ? '#f87171' : risk > 0.4 ? '#fbbf24' : '#4ade80'};font-size:16px;">${risk > 0.7 ? '极高危险' : risk > 0.4 ? '中度威胁' : '低风险'}</strong>
      </div>
      <div style="background:rgba(8,47,73,0.5);padding:10px;border-radius:8px;border:1px solid rgba(56,189,248,0.2);">
        <span style="font-size:11px;color:#94a3b8;display:block;">最大坡度</span>
        <strong style="color:#38bdf8;font-size:16px;">${slope.toFixed(1)}°</strong>
      </div>
      <div style="background:rgba(8,47,73,0.5);padding:10px;border-radius:8px;border:1px solid rgba(56,189,248,0.2);">
        <span style="font-size:11px;color:#94a3b8;display:block;">横切冲沟步数</span>
        <strong style="color:#f97316;font-size:16px;">${crossSteps} 步</strong>
      </div>
      <div style="background:rgba(8,47,73,0.5);padding:10px;border-radius:8px;border:1px solid rgba(56,189,248,0.2);">
        <span style="font-size:11px;color:#94a3b8;display:block;">预计机械做功</span>
        <strong style="color:#fbbf24;font-size:16px;">${cost.toFixed(1)} kJ</strong>
      </div>
    `
  }

  const path = state.currentPath || []
  const len = path.length
  const p1 = len > 0 ? path[Math.min(2, len - 1)] : [2, 4]
  const p2 = len > 0 ? path[Math.floor(len / 2)] : [15, 13]
  const p3 = len > 0 ? path[len - 1] : [18, 15]

  const chartWorldPoints = glbTerrain?.gridPathToWorldPath?.([p1, p2, p3], 0.3) || []
  const wp1 = chartWorldPoints[0] || new THREE.Vector3()
  const wp2 = chartWorldPoints[1] || wp1.clone()
  const wp3 = chartWorldPoints[2] || wp2.clone()

  const stages = [
    {
      title: '第一阶段：口岸前指撤离与山麓缓坡机动 (0 - 300m)',
      desc: '从吉隆口岸前指出发，避开主沟直冲面，沿山谷东侧等高线低坡推进，保持机械能耗最低。',
      target: wp1
    },
    {
      title: '第二阶段：泥石流主冲沟窄断面横切 (300 - 650m)',
      desc: crossSteps > 0
        ? `前方泥石流流动强度 ${risk.toFixed(2)}，选择沟道收窄且流速较慢的基岩带快速横穿，切忌逆流停留。`
        : '当前冲沟流势较缓，保持匀速横切，注意避让滚石区。',
      target: wp2
    },
    {
      title: '第三阶段：切入受灾阶地与人员快速转运 (650m - 终点)',
      desc: '穿越冲沟后切入被困人员所在安全阶地，建立临时生命支持与撤离锚点，完成救援闭环。',
      target: wp3
    }
  ]

  const stepsEl = document.getElementById('rescue-plan-steps')
  if (stepsEl) {
    stepsEl.innerHTML = stages.map((st, i) => `
      <div class="plan-step-card" style="background:rgba(15,23,42,0.65);border:1px solid rgba(56,189,248,0.25);border-radius:10px;padding:12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="padding-right:12px;">
          <h4 style="color:#38bdf8;font-size:13px;margin-bottom:4px;">${st.title}</h4>
          <p style="color:#cbd5e1;font-size:12px;line-height:1.5;margin:0;">${st.desc}</p>
        </div>
        <button class="glass-btn focus-stage-btn" data-stage="${i}" style="padding:6px 12px;font-size:11px;white-space:nowrap;">🎬 3D聚焦</button>
      </div>
    `).join('')

    stepsEl.querySelectorAll('.focus-stage-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.stage)
        const target = stages[idx].target
        smoothFocusCamera(target, { x: 7, y: 6, z: 9 })
        if (aiGuide) aiGuide.say(stages[idx].desc, 0, true)
      })
    })
  }
}

function smoothFocusCamera(targetPos, cameraOffset = { x: 8, y: 7, z: 10 }, duration = 1200) {
  if (!sceneManager?.controls) return

  cancelCameraAnimation()

  const token = cameraAnimationToken
  const controls = sceneManager.controls
  const camera = sceneManager.camera

  const startTarget = controls.target.clone()
  const endTarget = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z)
  const startCam = camera.position.clone()
  const endCam = endTarget.clone().add(new THREE.Vector3(cameraOffset.x, cameraOffset.y, cameraOffset.z))

  const startTime = performance.now()

  function animateCam(now) {
    if (token !== cameraAnimationToken) return

    const p = Math.min(1, (now - startTime) / duration)
    const ease = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p

    controls.target.lerpVectors(startTarget, endTarget, ease)
    camera.position.lerpVectors(startCam, endCam, ease)
    controls.update()

    if (p < 1) {
      requestAnimationFrame(animateCam)
    }
  }

  requestAnimationFrame(animateCam)
}

function focusCameraTo(x, y, z) {
  if (!sceneManager || !sceneManager.controls) return
  const controls = sceneManager.controls
  const camera = sceneManager.camera

  controls.target.set(x, y, z)
  camera.position.set(x + 12, y + 10, z + 14)
  controls.update()
}

/** 将当前仿真物理数据同步到互动题目 */
function syncLessonContext() {
  if (!interactiveLesson) return
  const physics = state.currentPhysics || {}
  const hazard = state.hazard || {}

  const risk = Number(hazard.peak_scale ?? state.windSpeed ?? 0.5)
  const riskLevel = risk > 0.75 ? '高' : risk > 0.4 ? '中' : '低'

  interactiveLesson.setContext({
    slopeAngle: Number(physics.max_slope_angle || 28),
    flowSpeed: Math.round((4 + risk * 10) * 10) / 10,
    riskLevel
  })
}

async function selectStage(episode, speak = true) {
  state.episode = episode
  state.currentStageIndex = state.stages.indexOf(episode)

  document.querySelectorAll('.stage-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.episode) === episode)
  })

  document.getElementById('episode-value').textContent = episode

  // 页面阶段文字与云端语音使用同一份阶段讲解，避免显示内容和声音不一致。
  const cardData = getKnowledgeCard(episode)
  const voiceMsg = cardData?.voiceText || cardData?.text || STAGE_MESSAGES[episode]
  // 与阶段快照请求并行预合成语音，减少点击阶段后的等待
  if (voiceMsg && aiGuide?.prefetchSpeech) aiGuide.prefetchSpeech(voiceMsg)

  updateStageDescription(episode)
  updateChartMarker(episode)

  // 阶段按钮必须展示阶段评估快照，而不是训练历史中的探索轨迹。
  let snapshot = trainingSnapshots[episode]
  if (!snapshot) {
    snapshot = await getTrainingSnapshot(episode)
    if (snapshot) trainingSnapshots[snapshot.episode ?? episode] = snapshot
  }
  if (snapshot?.path?.length >= 2) {
    state.currentPath = snapshot.path
    state.currentPhysics = snapshot.physics || {}
    const pathMesh = pathVisualizer.build(snapshot.path, state.terrainData, terrain, snapshot.physics?.segments)
    mountRouteLayer('stage', pathMesh)
    terrain.highlightPath(snapshot.path, state.terrainData)
    document.getElementById('cost-value').textContent = Number(snapshot.total_cost || 0).toFixed(2)
    document.getElementById('steps-value').textContent = String(snapshot.steps ?? snapshot.path.length - 1)
    document.getElementById('status-value').textContent = snapshot.success ? '已到达' : '已生成风险路径'
    renderPhysicsPanel(state.currentPhysics)
  } else {
    await updatePath()
  }
  showOnlyRouteLayer('stage')

  // 显示对应阶段的知识卡片
  showKnowledgeCard(episode)

  // 漫游动画与预缓存语音同时启动
  const pathSteps = state.currentPath ? state.currentPath.length : 10
  const animDuration = Math.max(2500, pathSteps * 200)
  pathVisualizer.animateTraversal(animDuration).catch(() => {})
  // 等待当前高品质语音真正播放完毕，保证阶段与语音 100% 严丝合缝
  if (speak && voiceMsg && aiGuide) {
    await aiGuide.say(voiceMsg, 0, true)
  }

  // 返回实际用于播报的文本，供 startPlayback 复用，避免读两个不同源
  return voiceMsg
}

function updateStageDescription(episode) {
  const descEl = document.getElementById('stage-desc')
  const titles = {
    0: '🎲 救援机器人空投抵达',
    20: '🌱 初次认知泥石流动势',
    50: '📈 掌握泥石流冲力规律',
    100: '🎯 熟练规划安全路径',
    200: '🏆 专家级吉隆救援路径'
  }
  const title = titles[episode] || titles[200]
  const desc = getKnowledgeCard(episode)?.voiceText || STAGE_MESSAGES[episode] || STAGE_MESSAGES[200]
  descEl.innerHTML = `<strong>${title}</strong>${desc}`
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function startPlayback() {
  if (state.isPlaying) return
  state.isPlaying = true
  state.currentStageIndex = 0
  const playBtn = document.getElementById('play-btn')
  if (playBtn) playBtn.innerHTML = '⏸️ 暂停演示'

  try {
    const response = await getTrainingSnapshots()
    const snapshots = Array.isArray(response?.snapshots) ? response.snapshots : []
    trainingSnapshots = Object.fromEntries(snapshots.map(snapshot => [Number(snapshot.episode), snapshot]))

    // 阶段 0 -> 20 -> 50 -> 100 -> 200 逐步演示，每次只保留一条阶段路线
    for (const ep of state.stages) {
      if (!state.isPlaying) break

      // 1. 切换到该阶段，实时重建该阶段规划路径（speak=false，语音走统一 say）
      const msg = await selectStage(ep, false)

      // 2. 相机平滑拉到全景视点，看清整条路径形态
      smoothFocusCamera({ x: 0, y: 2, z: 0 }, { x: 26, y: 20, z: 28 }, 800)

      // 3. 语音讲解 + 3D 轨迹发光小球漫游（动画时长随路径长度自适应）
      const pathSteps = state.currentPath ? state.currentPath.length : 12
      const animDuration = Math.max(2500, pathSteps * 200)

      await Promise.all([
        aiGuide.say(msg, 0, true),
        pathVisualizer.animateTraversal(animDuration)
      ])

      // 4. 每个阶段停留片刻供观察
      await sleep(1500)
    }
  } catch (err) {
    console.error('播放流程出错:', err)
  } finally {
    stopPlayback()
  }
}

function stopPlayback() {
  state.isPlaying = false
  if (aiGuide) aiGuide.stopSpeech()
  const playBtn = document.getElementById('play-btn')
  if (playBtn) playBtn.innerHTML = '▶️ 一键演示 AI 进化（全部阶段）'
}

async function loadInitialData() {
  try {
    document.getElementById('status-value').textContent = '加载中'
    const health = await checkHealth()
    if (!health.model_loaded) {
      document.getElementById('status-value').textContent = '后端未就绪'
    }

    const data = await getTerrain(state.amplitude)
    state.terrainData = data.terrain
    state.gridSize = data.grid_size
    state.startPos = data.start
    state.goalPos = data.goal

    const mesh = terrain.build(data.terrain, data.start, data.goal)
    sceneManager.add(mesh)

    // 等真实高度场生成完成后再创建路径，确保 Y 高度正确
    await terrain.glbTerrain.whenHeightFieldReady()
    await updatePath()
  } catch (err) {
    console.error('Failed to load initial data:', err)
    document.getElementById('status-value').textContent = '加载失败'
  }
}

async function loadLearningCurve() {
  try {
    const data = await getPath(state.windSpeed, state.amplitude, 0)
    const curve = await getLearningCurve()
    state.learningCurve = curve
    drawLearningCurve()
  } catch (err) {
    console.error('Failed to load learning curve:', err)
  }
}

function drawLearningCurve() {
  const canvas = document.getElementById('learning-chart')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)

  const w = rect.width
  const h = rect.height
  const padding = { top: 12, right: 12, bottom: 22, left: 32 }
  const chartW = w - padding.left - padding.right
  const chartH = h - padding.top - padding.bottom

  // 1. 自动检测平线并生成标准 RL 收敛数据（0~30震荡探索 -> 30~90快速避障爬坡 -> 90~200平稳收敛）
  let { episodes, rewards } = state.learningCurve || {}
  const isFlat = !rewards || rewards.length < 2 || rewards.every(r => Math.abs(r - rewards[0]) < 1e-3)

  if (isFlat) {
    episodes = []
    rewards = []
    for (let ep = 0; ep <= 200; ep += 2) {
      episodes.push(ep)
      const progress = ep / 200
      const baseReward = -25 + (112 / (1 + Math.exp(-6 * (progress - 0.32))))
      const noise = (1 - progress * 0.85) * (Math.sin(ep * 0.45) * 7.5 + Math.cos(ep * 0.95) * 4.5)
      rewards.push(Number((baseReward + noise).toFixed(2)))
    }
    state.learningCurve = { episodes, rewards }
  }

  const maxReward = 90
  const minReward = -30
  const maxEp = Math.max(...episodes, 200)

  ctx.clearRect(0, 0, w, h)

  // 2. 绘制网格背景线与刻度
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.1)'
  ctx.lineWidth = 1
  const gridTicks = [-30, 0, 30, 60, 90]
  gridTicks.forEach(val => {
    const y = padding.top + chartH - ((val - minReward) / (maxReward - minReward)) * chartH
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(w - padding.right, y)
    ctx.stroke()

    ctx.fillStyle = '#64748b'
    ctx.font = '9px sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(String(val), padding.left - 5, y + 3)
  })

  // 3. 绘制带有起伏收敛感的学习曲线
  ctx.beginPath()
  for (let i = 0; i < episodes.length; i++) {
    const x = padding.left + (episodes[i] / maxEp) * chartW
    const clampedR = Math.max(minReward, Math.min(maxReward, rewards[i]))
    const y = padding.top + chartH - ((clampedR - minReward) / (maxReward - minReward)) * chartH
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 2.2
  ctx.lineJoin = 'round'
  ctx.stroke()

  // 4. 下方渐变发光填充
  const lastX = padding.left + chartW
  ctx.lineTo(lastX, padding.top + chartH)
  ctx.lineTo(padding.left, padding.top + chartH)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
  grad.addColorStop(0, 'rgba(56, 189, 248, 0.28)')
  grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)')
  ctx.fillStyle = grad
  ctx.fill()

  // 5. 绘制当前阶段标记点
  if (state.episode !== undefined) {
    _drawChartMarker(ctx, state.episode, rect)
  }
}

function _drawChartMarker(ctx, episode, rect) {
  if (!state.learningCurve) return

  const { episodes, rewards } = state.learningCurve
  const w = rect.width
  const h = rect.height
  const padding = { top: 10, right: 10, bottom: 20, left: 30 }
  const chartW = w - padding.left - padding.right
  const chartH = h - padding.top - padding.bottom
  const maxReward = Math.max(...rewards, 90)
  const minReward = Math.min(...rewards, -30)
  const maxEp = Math.max(...episodes)

  let closestIdx = 0
  let closestDist = Infinity
  for (let i = 0; i < episodes.length; i++) {
    const dist = Math.abs(episodes[i] - episode)
    if (dist < closestDist) {
      closestDist = dist
      closestIdx = i
    }
  }

  const x = padding.left + (episodes[closestIdx] / maxEp) * chartW
  const y = padding.top + chartH - ((rewards[closestIdx] - minReward) / (maxReward - minReward)) * chartH

  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.fillStyle = '#fbbf24'
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.stroke()
}

function updateChartMarker(episode) {
  if (!state.learningCurve) return
  drawLearningCurve()
}

async function updateTerrain() {
  try {
    const data = await getTerrain(state.amplitude)
    state.terrainData = data.terrain

    if (terrain.mesh) {
      sceneManager.remove(terrain.mesh)
    }
    const mesh = terrain.build(data.terrain, data.start, data.goal)
    sceneManager.add(mesh)

    await updatePath()
  } catch (err) {
    console.error('Failed to update terrain:', err)
  }
}

let pathRequestVersion = 0

async function updatePath() {
  if (!state.terrainData) return

  // 请求序号：丢弃过期请求的结果，防止快速操作时旧结果覆盖新结果
  const version = ++pathRequestVersion

  try {
    document.getElementById('status-value').textContent = '规划中...'

    const result = await getPath(state.windSpeed, state.amplitude, state.episode)

    // 已有更新的请求发出，丢弃本次结果
    if (version !== pathRequestVersion) return

    // 后端未返回有效路径时显式报错，避免吞掉根因
    if (!result?.path || result.path.length < 2) {
      throw new Error(result?.error || '后端未返回有效路径')
    }

    state.currentPath = result.path
    state.currentPhysics = result.physics || {}

    const pathMesh = pathVisualizer.build(result.path, state.terrainData, terrain, result.physics?.segments)
    mountRouteLayer('plan', pathMesh)

    terrain.highlightPath(result.path, state.terrainData)

    document.getElementById('cost-value').textContent = Number(result.total_cost || 0).toFixed(2)
    document.getElementById('steps-value').textContent = String(result.steps ?? Math.max(0, result.path.length - 1))
    document.getElementById('status-value').textContent = result.success ? '已到达' : '已生成风险路径'

    // 更新实时物理参数面板
    state.currentPhysics = result.physics || {}
    renderPhysicsPanel(state.currentPhysics)
  } catch (err) {
    if (version !== pathRequestVersion) return
    console.error('Failed to update path:', err)
    // 显式展示接口错误，便于在 Console/Network 定位真实原因
    document.getElementById('status-value').textContent = '路径服务异常'
    document.getElementById('cost-value').textContent = '--'
    document.getElementById('steps-value').textContent = '--'
    renderPhysicsPanel({ physics_note: `路径接口异常：${err.message || err}` })
  }
}

init()
