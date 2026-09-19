// 物理知识库 - 按学科分类的核心公式与科普说明
// 用于"物理知识库"面板和"知识卡片"动态展示

export const physicsKnowledgeBase = {
  mechanics: {
    name: '经典力学',
    icon: '📐',
    color: '#4fc3f7',
    concepts: [
      {
        name: '重力与重力分力',
        formula: 'F_g = mg,  F_∥ = mg·sinθ',
        description: '上坡时，重力沿坡面方向的分力阻碍前进。坡度 θ 越大，分力越大，消耗越多。',
        variables: [
          { sym: 'm', desc: '人体质量 (kg)', val: '70' },
          { sym: 'g', desc: '重力加速度 (m/s²)', val: '9.8' },
          { sym: 'θ', desc: '坡面倾角 (°)', val: '动态' }
        ]
      },
      {
        name: '摩擦力',
        formula: 'f = μ·F_N = μ·mg·cosθ',
        description: '坡面行走时，正压力随坡度变化。坡度越大，正压力越小，摩擦力减小，抓地力下降。',
        variables: [
          { sym: 'μ', desc: '摩擦系数', val: '0.6' },
          { sym: 'F_N', desc: '正压力 (N)', val: 'mg·cosθ' }
        ]
      },
      {
        name: '功与重力势能',
        formula: 'W = F·d,  E_p = mgh',
        description: '上坡时重力势能增加，需要对外做功。爬升高度 Δh 消耗的能量为 mg·Δh。',
        variables: [
          { sym: 'W', desc: '功 (J)', val: 'F·d' },
          { sym: 'E_p', desc: '重力势能 (J)', val: 'mgh' },
          { sym: 'h', desc: '爬升高度 (m)', val: '动态' }
        ]
      },
      {
        name: '牛顿第二定律',
        formula: 'F = ma',
        description: '救援人员在坡面上加速/减速时，驱动力等于质量乘以加速度。坡度大时需要更大驱动力。',
        variables: [
          { sym: 'F', desc: '合外力 (N)', val: 'ma' },
          { sym: 'a', desc: '加速度 (m/s²)', val: '动态' }
        ]
      },
      {
        name: '功率',
        formula: 'P = F·v',
        description: '救援人员单位时间输出功率有限。坡度大、风阻大时，需要降低速度以维持功率平衡。',
        variables: [
          { sym: 'P', desc: '功率 (W)', val: 'F·v' },
          { sym: 'v', desc: '速度 (m/s)', val: '动态' }
        ]
      }
    ]
  },
  fluid: {
    name: '流体力学 · 泥石流',
    icon: '💧',
    color: '#81d4fa',
    concepts: [
      {
        name: '泥石流动压冲力',
        formula: 'F_泥 = ½·ρ_泥·C_d·A·v_泥²',
        description: '流动泥浆对机器人的冲力，与空气阻力同源但密度大1300倍！泥石流流速翻倍，冲力变四倍，能把机器人冲下山。',
        variables: [
          { sym: 'ρ_泥', desc: '泥浆密度 (kg/m³)', val: '1600' },
          { sym: 'C_d', desc: '阻力系数', val: '0.8' },
          { sym: 'A', desc: '机器人迎流面积 (m²)', val: '0.5' },
          { sym: 'v_泥', desc: '泥石流流速 (m/s)', val: '2-15' }
        ]
      },
      {
        name: '泥石流流速与流动强度',
        formula: 'v_泥 = 流动强度 × 10 m/s',
        description: '泥石流流速由流动强度决定（0=静止泥浆，1=最强泥石流）。强度0.5时流速5 m/s，已可冲倒成年人。',
        variables: [
          { sym: 'v_泥', desc: '泥浆流速 (m/s)', val: '动态' },
          { sym: '流动强度', desc: '0-1无量纲', val: '滑块调节' }
        ]
      },
      {
        name: '黏性泥浆附加能耗',
        formula: 'W_黏 = F_泥 · d · η_黏',
        description: '泥浆黏性远大于空气，机器人在泥浆中行进时除对抗冲力外，还需克服黏性阻力，能耗约增加12%。',
        variables: [
          { sym: 'W_黏', desc: '黏性附加能耗 (J)', val: 'F·d·η' },
          { sym: 'η_黏', desc: '黏性系数', val: '0.12' }
        ]
      },
      {
        name: '动量守恒与冲量',
        formula: 'F·Δt = m·Δv',
        description: '泥石流冲击机器人时，冲量等于动量变化。机器人越重（75kg），被冲偏所需时间越长，但能耗仍很大。',
        variables: [
          { sym: 'F', desc: '冲力 (N)', val: '动态' },
          { sym: 'Δt', desc: '作用时间 (s)', val: '—' },
          { sym: 'm', desc: '机器人质量 (kg)', val: '75' }
        ]
      }
    ]
  },
  thermo: {
    name: '热力学',
    icon: '🔥',
    color: '#ffab91',
    concepts: [
      {
        name: '人体代谢产热',
        formula: 'Q = P_met · t',
        description: '高海拔+大坡度+逆风时，人体代谢产热增加，散热困难。需关注体力消耗与体温调节。',
        variables: [
          { sym: 'Q', desc: '产热量 (J)', val: 'P_met·t' },
          { sym: 'P_met', desc: '代谢功率 (W)', val: '300~800' },
          { sym: 't', desc: '时间 (s)', val: '动态' }
        ]
      }
    ]
  },
  optimization: {
    name: '优化理论',
    icon: '🎯',
    color: '#ce93d8',
    concepts: [
      {
        name: '路径代价最小化',
        formula: 'min Σ Cost_i = min Σ(距离 + 坡度惩罚 + 风阻惩罚)',
        description: 'AI的目标是找到总代价最小的路径。代价 = 基础距离 + 坡度惩罚 + 逆风惩罚。',
        variables: [
          { sym: 'Cost', desc: '单步代价', val: '1 + 坡度 + 风阻' },
          { sym: '坡度惩罚', desc: 'max(0, Δh)×0.3', val: '动态' },
          { sym: '风阻惩罚', desc: 'max(0, 逆风)×0.5', val: '动态' }
        ]
      },
      {
        name: '梯度下降',
        formula: 'θ_{t+1} = θ_t - η·∇J(θ)',
        description: 'DQN的损失函数优化过程本质是梯度下降。神经网络沿损失减小的方向更新参数。',
        variables: [
          { sym: 'θ', desc: '网络参数', val: '—' },
          { sym: 'η', desc: '学习率', val: '1e-4' },
          { sym: '∇J', desc: '损失梯度', val: '—' }
        ]
      }
    ]
  },
  rl: {
    name: '强化学习',
    icon: '🧠',
    color: '#a5d6a7',
    concepts: [
      {
        name: 'Q-Learning 更新公式',
        formula: 'Q(s,a) ← Q(s,a) + α[r + γ·max Q(s\',a\') - Q(s,a)]',
        description: 'AI每次行动后更新Q值。新Q值 = 旧Q值 + 学习率 × (即时奖励 + 折扣未来奖励 - 旧Q值)。',
        variables: [
          { sym: 'Q(s,a)', desc: '状态-动作价值', val: '—' },
          { sym: 'α', desc: '学习率', val: '1e-4' },
          { sym: 'γ', desc: '折扣因子', val: '0.99' },
          { sym: 'r', desc: '即时奖励', val: '—' }
        ]
      },
      {
        name: '贝尔曼方程',
        formula: 'V(s) = max_a [R(s,a) + γ·Σ P(s\'|s,a)·V(s\')]',
        description: '强化学习的数学基础：当前状态的价值 = 当前奖励 + 折扣后的未来期望奖励。',
        variables: [
          { sym: 'V(s)', desc: '状态价值', val: '—' },
          { sym: 'R(s,a)', desc: '奖励函数', val: '—' },
          { sym: 'P', desc: '状态转移概率', val: '—' }
        ]
      },
      {
        name: 'ε-greedy 策略',
        formula: 'π(s) = { 随机(概率ε), argmax Q(s,a) (概率1-ε) }',
        description: '平衡探索与利用。ε大时多探索（试错），ε小时多利用（已知最优）。训练中ε逐渐衰减。',
        variables: [
          { sym: 'ε', desc: '探索概率', val: '1.0→0.01' },
          { sym: 'π(s)', desc: '策略', val: '—' }
        ]
      }
    ]
  }
}

// 训练阶段 → 知识卡片映射（吉隆口岸泥石流救援叙事）
export const stageKnowledgeCards = {
  0: {
    discipline: '强化学习',
    disciplineIcon: '🧠',
    topic: '救援机器人空投抵达',
    topicIcon: '🎲',
    text: '2026年8月26日吉隆口岸泥石流刚爆发！AI空投抵达灾区，对峡谷地形一无所知，只能随机蹒跚探索。',
    formula: 'π(s) = { 随机动作(ε), argmax Q(s,a)(1-ε) }',
    formulaLabel: 'ε-greedy 策略',
    detail: '当前 ε = 1.0，所有动作都是随机的。AI通过试错在泥石流灾区积累经验。',
    voiceText: '我刚空投抵达吉隆口岸灾区！什么都不懂，只能随机乱走。不过没关系，我会通过试错慢慢学习如何在泥石流灾区救援。'
  },
  20: {
    discipline: '经典力学',
    disciplineIcon: '📐',
    topic: '爬坡机械能认知',
    topicIcon: '⛰️',
    text: 'AI发现爬陡坡特别累！因为上坡时需要克服重力做功，能量消耗急剧增加。',
    formula: 'W = mg·Δh,  F∥ = mg·sinθ',
    formulaLabel: '重力做功公式',
    detail: 'ε ≈ 0.7。AI学到爬坡做功 W=mgΔh，每爬升1米75kg机器人需做功735J。',
    voiceText: '我发现爬陡坡特别累！物理学说，上坡做功等于mgh，我75公斤爬1米就要735焦耳。所以我开始避开陡坡。'
  },
  50: {
    discipline: '流体力学 · 泥石流',
    disciplineIcon: '💧',
    topic: '泥石流冲力规律',
    topicIcon: '🌊',
    text: 'AI明白关键规律：横切泥石流方向走，流动泥浆的侧向冲力会指数级增加能耗，甚至把机器人冲下山！',
    formula: 'F_泥 = ½·ρ_泥·C_d·A·v_泥²',
    formulaLabel: '泥石流动压冲力',
    detail: 'ε ≈ 0.4。泥浆密度1600 kg/m³是空气的1300倍，逆泥石流方向走代价极高。AI学会绕开冲沟。',
    voiceText: '我明白了关键规律！横切泥石流方向走会被泥浆冲下山。泥浆密度是空气的1300倍，冲力极大。必须绕开冲沟！'
  },
  100: {
    discipline: '优化理论',
    disciplineIcon: '🎯',
    topic: '沿等高线安全绕行',
    topicIcon: '🗺️',
    text: 'AI像老练救援队员：优先沿等高线绕着泥石流沟走，避开最危险流路径，大幅降低阻力。',
    formula: 'min Σ Cost_i = min Σ(1 + 坡度惩罚 + 泥石流冲力惩罚)',
    formulaLabel: '总代价最小化',
    detail: 'ε ≈ 0.15。AI已学会综合爬坡做功和泥石流冲力，沿等高线规划安全路径。',
    voiceText: '我现在像老练救援队员了！沿等高线绕开泥石流沟，避开最危险的流路径，大幅降低阻力代价。'
  },
  200: {
    discipline: '能量守恒',
    disciplineIcon: '🔋',
    topic: '电池续航最小化',
    topicIcon: '🏆',
    text: 'AI完全收敛，用最小机械能消耗找到最快抵达被困人员的路线，电池续航最优化！',
    formula: 'E_电池 = (W_爬坡 + W_泥石流 + W_黏性) / η',
    formulaLabel: '电池能量公式',
    detail: 'ε ≈ 0.01。AI综合考虑爬坡机械能、泥石流冲力做功、黏性附加能耗，最小化电池能量消耗。',
    voiceText: '200轮训练完成！我已完全收敛，用最小电池能量找到最快抵达被困人员的路线。这就是吉隆口岸泥石流救援专家级路径！'
  }
}

// 获取指定训练阶段的知识卡片
export function getKnowledgeCard(episode) {
  const stages = [0, 20, 50, 100, 200]
  let selected = stages[0]
  for (const s of stages) {
    if (episode >= s) selected = s
  }
  return stageKnowledgeCards[selected]
}

// 物理常量
export const PHYSICS_CONSTANTS = {
  mass: 70,           // 人体质量 kg
  g: 9.8,             // 重力加速度 m/s²
  airDensity: 1.225,  // 空气密度 kg/m³
  dragCoeff: 0.8,     // 拖曳系数
  frontalArea: 0.6,   // 迎风面积 m²
  frictionCoeff: 0.6, // 摩擦系数
  walkSpeed: 1.2      // 行走速度 m/s
}

// 计算实时物理参数
export function calcPhysicsState(terrainData, path, windSpeed, amplitude) {
  if (!path || path.length < 2) return null

  let totalHeightGain = 0
  let maxSlopeAngle = 0
  let totalSlopeCost = 0
  let totalWindCost = 0
  let totalDistance = 0

  const gs = terrainData.length
  const cellDist = 1.0 // 网格单位距离

  for (let i = 0; i < path.length - 1; i++) {
    const [i1, j1] = path[i].map(v => Math.floor(v))
    const [i2, j2] = path[i + 1].map(v => Math.floor(v))

    const h1 = terrainData[Math.min(i1, gs - 1)][Math.min(j1, gs - 1)]
    const h2 = terrainData[Math.min(i2, gs - 1)][Math.min(j2, gs - 1)]
    const dh = h2 - h1
    const dist = Math.sqrt((i2 - i1) ** 2 + (j2 - j1) ** 2) * cellDist

    totalDistance += dist

    if (dh > 0) {
      totalHeightGain += dh
      const slopeAngle = Math.atan2(dh, dist) * 180 / Math.PI
      if (slopeAngle > maxSlopeAngle) maxSlopeAngle = slopeAngle
      totalSlopeCost += dh * 0.3
    }

    // 风向：[0, 1] 即 y 正方向
    const moveVec = [i2 - i1, j2 - j1]
    const windDir = [0, 1]
    const dot = moveVec[0] * windDir[0] + moveVec[1] * windDir[1]
    const windEffect = -dot * windSpeed
    if (windEffect > 0) {
      totalWindCost += windEffect * 0.5
    }
  }

  const m = PHYSICS_CONSTANTS.mass
  const g = PHYSICS_CONSTANTS.g
  const rho = PHYSICS_CONSTANTS.airDensity
  const Cd = PHYSICS_CONSTANTS.dragCoeff
  const A = PHYSICS_CONSTANTS.frontalArea

  // 平均坡度角对应的重力分力
  const avgSlopeRad = maxSlopeAngle * Math.PI / 180
  const gravityForce = m * g * Math.sin(avgSlopeRad)
  const frictionForce = PHYSICS_CONSTANTS.frictionCoeff * m * g * Math.cos(avgSlopeRad)

  // 风阻（逆风相对速度 = 行走速度 + 风速）
  const relSpeed = PHYSICS_CONSTANTS.walkSpeed + windSpeed * 8 // 风速缩放
  const windDrag = 0.5 * rho * Cd * A * relSpeed * relSpeed

  const totalResistance = gravityForce + (windSpeed > 0 ? windDrag : 0)

  // 爬升做的功
  const climbWork = m * g * totalHeightGain * 0.5 // 0.5 是地形高度缩放

  return {
    maxSlopeAngle: maxSlopeAngle.toFixed(1),
    gravityForce: gravityForce.toFixed(0),
    frictionForce: frictionForce.toFixed(0),
    windDrag: windDrag.toFixed(1),
    totalResistance: totalResistance.toFixed(0),
    totalHeightGain: totalHeightGain.toFixed(2),
    climbWork: (climbWork / 1000).toFixed(1), // kJ
    totalSlopeCost: totalSlopeCost.toFixed(2),
    totalWindCost: totalWindCost.toFixed(2),
    totalDistance: totalDistance.toFixed(0),
    steps: path.length - 1
  }
}
