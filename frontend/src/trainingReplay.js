import * as THREE from 'three'

/**
 * AI 训练回放：展示"探索—碰壁—调整—收敛"过程
 *
 * - 历史幽灵轨迹：早期蓝/中期橙/后期黄，透明度递增
 * - 当前回合 Agent：蓝色小球沿 step.position 移动
 * - 当前轨迹：按风险染色（蓝→橙→红）
 */
export class TrainingReplay {
  constructor(scene, glbTerrain) {
    this.scene = scene
    this.glbTerrain = glbTerrain
    this.ghostPaths = []
    this.agent = null
    this.currentTrace = null
    this.timer = null
    this.episodes = []
    this.currentEpIdx = 0
    this.isPlaying = false
    this.onStep = null  // 回调：更新训练面板
    this.onStage = null // 回调：阶段转场讲解
    // 详细回放节奏（更快、无人工停顿）
    this.playSpeed = 0.9
    this.pauseBetweenEpisodes = 120
    this.stagePause = 0
  }

  _easeInOut(t) {
    return t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2
  }

  stop() {
    this.isPlaying = false
    if (this._tickHandle) {
      cancelAnimationFrame(this._tickHandle)
      this._tickHandle = null
    }
    if (this._stageTimer) {
      clearTimeout(this._stageTimer)
      this._stageTimer = null
    }
  }

  clear() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this._tickHandle) {
      cancelAnimationFrame(this._tickHandle)
      this._tickHandle = null
    }
    if (this._stageTimer) {
      clearTimeout(this._stageTimer)
      this._stageTimer = null
    }
    this.isPlaying = false
    for (const item of this.ghostPaths) {
      this.scene.remove(item)
      if (item.geometry) item.geometry.dispose()
      if (item.material) item.material.dispose()
    }
    this.ghostPaths = []
    if (this.agent) {
      this.scene.remove(this.agent)
      this.agent.geometry.dispose()
      this.agent.material.dispose()
      this.agent = null
    }
    if (this.currentTrace) {
      this.scene.remove(this.currentTrace)
      this.currentTrace.geometry.dispose()
      this.currentTrace.material.dispose()
      this.currentTrace = null
    }
  }

  _gridToWorld(i, j) {
    // 统一坐标链路：必须走 glbTerrain.gridToWorld，禁止 j-12 / j*cellSize 硬编码
    if (this.glbTerrain) return this.glbTerrain.gridToWorld(i, j)
    return null
  }

  _getHeight(x, z) {
    if (!this.glbTerrain) return 0
    const h = this.glbTerrain.getHeight(x, z)
    return Number.isFinite(h) ? h : 0
  }

  // 绘制一条幽灵轨迹（历史路径）
  _drawGhostPath(points, phase) {
    if (!points || points.length < 2) return
    const style = {
      early: { color: 0x38bdf8, opacity: 0.12 },
      middle: { color: 0xf97316, opacity: 0.22 },
      final: { color: 0xfacc15, opacity: 0.85 }
    }[phase] || { color: 0x38bdf8, opacity: 0.12 }

    const worldPts = points.map(([i, j]) => {
      const p = this._gridToWorld(i, j)
      // 抬高 0.35m，确保悬浮在 GLB 地形之上，不被地面 Mesh 吞没
      const y = this._getHeight(p.x, p.z) + 0.35
      return new THREE.Vector3(p.x, y, p.z)
    })
    const curve = new THREE.CatmullRomCurve3(worldPts, false, 'centripetal')
    const geo = new THREE.TubeGeometry(curve, Math.max(24, worldPts.length * 4), 0.05, 10, false)
    const mat = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: style.opacity,
      depthWrite: false,
      depthTest: true
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 2
    this.scene.add(mesh)
    this.ghostPaths.push(mesh)
  }

  // 绘制历史轨迹背景（早期+中期+最终各一条代表）
  drawHistoryBackground(episodes) {
    this.episodes = episodes
    // 取早期(前1/4)、中期(中)、最终(最后成功或最后一条)
    const n = episodes.length
    if (n === 0) return
    const early = episodes[Math.min(2, n - 1)]
    const middle = episodes[Math.floor(n / 2)]
    const successful = episodes.filter(e => e.success)
    const finalEp = successful.length > 0
      ? successful[successful.length - 1]
      : episodes[n - 1]

    this._drawGhostPath(early.path, 'early')
    this._drawGhostPath(middle.path, 'middle')
    this._drawGhostPath(finalEp.path, 'final')
  }

  _ensureAgent() {
    if (!this.agent) {
      const geo = new THREE.SphereGeometry(0.13, 14, 10)
      const mat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.95
      })
      this.agent = new THREE.Mesh(geo, mat)
      this.scene.add(this.agent)
    }
  }

  // 播放单个回合的逐步轨迹（基于时间的缓动，不再用固定 setInterval）
  playEpisode(episode, onStep, onComplete) {
    this._ensureAgent()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    const steps = episode.steps || []
    if (!steps.length) {
      onComplete?.()
      return
    }

    const pathPoints = []
    let index = 0
    let segmentElapsed = 0
    let lastTime = performance.now()
    const segmentDuration = 0.72

    const tick = (now) => {
      if (!this.isPlaying) return

      const delta = Math.min((now - lastTime) / 1000, 0.05)
      lastTime = now
      segmentElapsed += delta * this.playSpeed

      if (index >= steps.length - 1) {
        // 收尾：把最后一个点补上
        const lastStep = steps[steps.length - 1]
        const [li, lj] = lastStep.position
        const lp = this._gridToWorld(li, lj)
        const ly = this._getHeight(lp.x, lp.z) + 0.16
        pathPoints.push(new THREE.Vector3(lp.x, ly, lp.z))
        this.agent.position.set(lp.x, ly, lp.z)
        this._redrawCurrentTrace(pathPoints, lastStep.risk)

        if (onStep) {
          onStep({
            episode: episode.episode,
            step: steps.length,
            totalSteps: steps.length,
            reward: lastStep.reward,
            cost: lastStep.cost,
            slopeRisk: lastStep.slope_risk,
            debrisRisk: lastStep.debris_risk,
            epsilon: episode.epsilon,
            hitHazard: lastStep.hit_hazard,
            success: episode.success
          })
        }
        onComplete?.()
        return
      }

      const current = steps[index]
      const next = steps[index + 1]
      const progress = Math.min(segmentElapsed / segmentDuration, 1)
      const eased = this._easeInOut(progress)

      const [ci, cj] = current.position
      const [ni, nj] = next.position
      const cp = this._gridToWorld(ci, cj)
      const np = this._gridToWorld(ni, nj)
      const cy = this._getHeight(cp.x, cp.z) + 0.16
      const ny = this._getHeight(np.x, np.z) + 0.16

      const x = cp.x + (np.x - cp.x) * eased
      const y = cy + (ny - cy) * eased
      const z = cp.z + (np.z - cp.z) * eased
      this.agent.position.set(x, y, z)

      // 完成一个分段时把锚点加入轨迹，避免每帧重建管道
      if (progress >= 1) {
        pathPoints.push(new THREE.Vector3(cp.x, cy, cp.z))
        this._redrawCurrentTrace(pathPoints, current.risk)

        if (onStep) {
          onStep({
            episode: episode.episode,
            step: index + 1,
            totalSteps: steps.length,
            reward: current.reward,
            cost: current.cost,
            slopeRisk: current.slope_risk,
            debrisRisk: current.debris_risk,
            epsilon: episode.epsilon,
            hitHazard: current.hit_hazard,
            success: episode.success
          })
        }
        index += 1
        segmentElapsed = 0
      }

      this._tickHandle = requestAnimationFrame(tick)
    }

    this.isPlaying = true
    this._tickHandle = requestAnimationFrame(tick)
  }

  _redrawCurrentTrace(points, risk) {
    if (this.currentTrace) {
      this.scene.remove(this.currentTrace)
      this.currentTrace.geometry.dispose()
      this.currentTrace.material.dispose()
    }
    if (points.length < 2) return
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
    const color = risk > 0.7 ? 0xef4444 : risk > 0.4 ? 0xf59e0b : 0x38bdf8
    const geo = new THREE.TubeGeometry(curve, Math.max(24, points.length * 4), 0.06, 10, false)
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: true
    })
    this.currentTrace = new THREE.Mesh(geo, mat)
    this.currentTrace.renderOrder = 3
    this.scene.add(this.currentTrace)
  }

  // 依次播放所有回合（分阶段：探索 → 调整 → 收敛）
  // 优化：精选代表性回合，避免太多冗余回合糊成一片；
  //       每回合结束后将其作为幽灵轨迹沉淀，体现学习演进过程
  playAll(episodes, onStep, onComplete, options = {}) {
    this.clear()
    if (!episodes || episodes.length === 0) {
      onComplete?.()
      return
    }
    const normalizedEpisodes = episodes.map((episode, index) => {
      if (Array.isArray(episode?.steps) && episode.steps.length) return episode
      const path = Array.isArray(episode?.path) ? episode.path : []
      const steps = path.map((position, stepIndex) => ({
        position,
        reward: 0,
        cost: null,
        slope_risk: 0,
        debris_risk: 0,
        risk: 0,
        hit_hazard: false
      }))
      return { ...episode, episode: episode?.episode ?? index, steps, path }
    })

    // 筛选出最能体现学习过程的代表性回合（避免太多导致看不清变化）
    const total = normalizedEpisodes.length
    const keyIndices = [
      0,                              // 初始随机探索
      Math.floor(total * 0.1),        // 早期碰壁
      Math.floor(total * 0.25),       // 发现重力阻力
      Math.floor(total * 0.45),       // 遭遇泥石流冲击
      Math.floor(total * 0.7),        // 开始绕行
      total - 1                       // 专家级收敛
    ].filter((v, i, a) => a.indexOf(v) === i && v < total && v >= 0)

    const mode = String(options.mode || (options.detailed ? 'detailed' : 'summary')).toLowerCase()
    const sortedEpisodes = [...normalizedEpisodes].sort((a, b) => Number(a.episode ?? 0) - Number(b.episode ?? 0))
    const representativeEpisodes = mode === 'detailed' || options.detailed === true
      ? sortedEpisodes
      : keyIndices.map(idx => normalizedEpisodes[idx])
    this.playSpeed = Number.isFinite(options.speed) ? options.speed : 0.62
    this.pauseBetweenEpisodes = Number.isFinite(options.pauseBetweenEpisodes)
      ? options.pauseBetweenEpisodes
      : 900
    this.stagePause = Number.isFinite(options.stagePause)
      ? options.stagePause
      : 1800
    this.episodes = representativeEpisodes
    this.isPlaying = true

    const stages = [
      {
        name: '① 盲目探索阶段 (ε=1.0)',
        from: 0,
        to: Math.ceil(representativeEpisodes.length * 0.35),
        message: '【探索期】AI 刚抵达灾区，对地形一无所知，正在随机试错、碰壁探索。'
      },
      {
        name: '② 风险认知阶段 (ε≈0.4)',
        from: Math.ceil(representativeEpisodes.length * 0.35),
        to: Math.ceil(representativeEpisodes.length * 0.7),
        message: '【认知期】AI 感受到了爬坡与泥石流的巨大阻力，开始主动避开危险冲沟。'
      },
      {
        name: '③ 策略收敛阶段 (ε≈0.01)',
        from: Math.ceil(representativeEpisodes.length * 0.7),
        to: representativeEpisodes.length,
        message: '【收敛期】AI 综合机械能做功与流体冲力，规划出能耗最低的最优救援路线！'
      }
    ]

    let stageIndex = 0
    let episodeIndex = 0

    const playNext = () => {
      if (!this.isPlaying) return

      const stage = stages[stageIndex]
      if (!stage || episodeIndex >= representativeEpisodes.length) {
        this.isPlaying = false
        onComplete?.()
        return
      }

      // 阶段转场提醒与语音联动：在阶段起始时触发
      if (episodeIndex === stage.from) {
        this.onStage?.(stage)
      }

      const ep = representativeEpisodes[episodeIndex]
      this.currentEpIdx = episodeIndex

      // 播放当前回合的逐步移动
      this.playEpisode(ep, (data) => {
        onStep?.(data)
      }, () => {
        // 当前回合结束后，将其作为幽灵轨迹沉淀在地面上，体现历史学习过程
        const phase = episodeIndex < stage.to * 0.5
          ? 'early'
          : (episodeIndex < representativeEpisodes.length - 1 ? 'middle' : 'final')
        this._drawGhostPath(ep.path, phase)

        episodeIndex += 1
        if (episodeIndex >= stage.to && stageIndex < stages.length - 1) {
          stageIndex += 1
          this._stageTimer = setTimeout(playNext, this.stagePause || 1200)
        } else {
          this._stageTimer = setTimeout(playNext, this.pauseBetweenEpisodes || 500)
        }
      })
    }

    playNext()
  }
}
