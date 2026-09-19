/**
 * 互动科普模块：救援决策实验室（物理决策实验）
 *
 * 三关任务均基于当前仿真的真实物理数据，不再是静态判断：
 *   1. 判断泥石流运动方向 —— 展示沟道坡度、泥浆流速、机器人位置
 *   2. 比较路径代价 —— 展示两条候选方案的距离/坡度/逆流步数
 *   3. 选择救援速度 —— 基于动压阻力公式 F_泥 = ½·ρ·C_d·A·v²
 *
 * 每关回答后给出对应的物理解释，并把选择结果传给仿真模型。
 */
/**
 * 答题反馈语音（固定文案）。导出给初始化预加载使用：答题时直接命中缓存、秒出声。
 */
export const LESSON_FEEDBACK_SPEECHES = [
  '判断正确。现在我们把这条知识应用到救援仿真中。',
  '这个选择存在风险。我们一起看看地形和物理规律。'
]

export class InteractiveLesson {
  constructor({ panel, aiGuide, onDecision }) {
    this.panel = panel
    this.aiGuide = aiGuide
    this.onDecision = onDecision
    this.step = 0
    this.score = 0

    // 当前仿真数据（由 main.js 通过 setContext 注入）
    this.context = {
      slopeAngle: 28,        // 沟道坡度（度）
      flowSpeed: 8.4,        // 泥浆流速 m/s
      robotSide: '沟道东侧',  // 机器人位置
      planA: { distance: 8.2, maxSlope: 31, headwind: 5 },
      planB: { distance: 10.6, maxSlope: 14, headwind: 0 },
      riskLevel: '中'         // 当前泥石流风险等级
    }
  }

  /**
   * 更新仿真上下文数据，题目会据此展示实时数值
   */
  setContext(ctx) {
    this.context = { ...this.context, ...ctx }
  }

  /** 构建当前关卡（根据 context 动态生成题目文本） */
  _buildLessons() {
    const c = this.context
    return [
      {
        title: '任务一：判断泥石流运动方向',
        dataBox: `
          <div class="lesson-data">
            <div><span>当前流向</span><strong>沿沟谷向下游</strong></div>
            <div><span>沟道坡度</span><strong>${c.slopeAngle}°</strong></div>
            <div><span>泥浆流速</span><strong>${c.flowSpeed} m/s</strong></div>
            <div><span>机器人位置</span><strong>${c.robotSide}</strong></div>
          </div>
        `,
        question: '机器人要前往救援点，最需要避开的方向是什么？',
        options: [
          {
            text: '横穿沟道',
            correct: true,
            explanation: '正确。横穿沟道会直接暴露在泥石流主流中，迎流面积和横向冲力大增，这是最需要避开的方向。泥石流受重力控制，沿沟谷和低洼通道向下游运动。'
          },
          {
            text: '沿等高线绕行',
            correct: false,
            explanation: '沿等高线绕行本身是安全做法，但本题问的是"最需要避开的方向"。真正的危险是横穿沟道——它会增加迎流面积和横向冲力，风险远高于沿等高线绕行。'
          },
          {
            text: '向沟谷最低处靠近',
            correct: false,
            explanation: '向沟谷最低处靠近会进入泥石流冲刷最集中、流速最大的区域。泥石流受重力控制，沿低洼通道快速下泄，这里是超过沟道上最危险的落点之一。'
          }
        ]
      },
      {
        title: '任务二：比较路径代价',
        dataBox: `
          <div class="lesson-plans">
            <div class="plan-card">
              <div class="plan-name">方案 A</div>
              <div>距离 <strong>${c.planA.distance} m</strong></div>
              <div>最大坡度 <strong>${c.planA.maxSlope}°</strong></div>
              <div>逆流步数 <strong>${c.planA.headwind}</strong></div>
            </div>
            <div class="plan-card">
              <div class="plan-name">方案 B</div>
              <div>距离 <strong>${c.planB.distance} m</strong></div>
              <div>最大坡度 <strong>${c.planB.maxSlope}°</strong></div>
              <div>逆流步数 <strong>${c.planB.headwind}</strong></div>
            </div>
          </div>
        `,
        question: `在泥石流强度较高时，哪个方案的综合风险更低？（风险等级：${c.riskLevel}）`,
        options: [
          {
            text: '方案 A：距离更短',
            correct: false,
            explanation: '方案 A 虽然距离短，但最大坡度达 31° 且有 5 步逆流，爬坡代价和泥石流冲力代价显著更高，综合风险并不低。'
          },
          {
            text: '方案 B：坡度缓、无逆流',
            correct: true,
            explanation: '正确。总路径代价 = 距离代价 + 爬坡代价 + 泥石流冲力代价。方案 B 坡度缓（14°）、无逆流，综合代价最低。'
          },
          {
            text: '两者风险相同',
            correct: false,
            explanation: '两个方案代价明显不同：方案 A 距离短但坡度大、逆流 5 步，爬坡与冲力代价都高于坡度缓且无逆流的方案 B，并非风险相同。'
          }
        ]
      },
      {
        title: '任务三：选择救援速度',
        dataBox: `
          <div class="lesson-formula">
            <div class="formula-title">泥石流冲力公式</div>
            <div class="formula-body">F<sub>泥</sub> = ½ · ρ<sub>泥</sub> · C<sub>d</sub> · A · v²</div>
            <div class="formula-note">泥浆流速 ${c.flowSpeed} m/s，冲力与速度的平方成正比</div>
          </div>
        `,
        question: '在高流速泥石流中，机器人应该如何选择行进策略？',
        options: [
          {
            text: '快速横穿，缩短暴露时间',
            correct: false,
            explanation: '快速横穿存在风险。冲力与速度的平方成正比（F=½·ρ·Cd·A·v²），提高速度会让冲击风险急剧放大，缩短暴露时间并不能抵消 v² 带来的冲击成倍增加。'
          },
          {
            text: '低速沿高地绕行',
            correct: true,
            explanation: '正确。低速降低公式中的速度项、沿高地避开主流、绕行脱离沟道，三项叠加使综合风险最低，符合 F=½·ρ·Cd·A·v² 的物理规律。'
          },
          {
            text: '停在沟道中心观察',
            correct: false,
            explanation: '停在沟道中心会持续暴露在流速最大、冲力最强的流核中，且毫无机动余地。面对高流速泥石流应优先离开沟道，而不是停留观察。'
          }
        ]
      }
    ]
  }

  start() {
    this.step = 0
    this.score = 0
    if (this.aiGuide) this.aiGuide.stopSpeech()
    this.render()
  }

  render() {
    const lessons = this._buildLessons()
    const lesson = lessons[this.step]
    if (!lesson) {
      this.renderSummary()
      return
    }

    this.panel.innerHTML = `
      <div class="lesson-progress">
        学习任务 ${this.step + 1} / ${lessons.length}
      </div>
      <h3>${lesson.title}</h3>
      ${lesson.dataBox || ''}
      <p class="lesson-question">${lesson.question}</p>
      <div class="lesson-options">
        ${lesson.options.map((option, index) => `
          <button class="lesson-option" data-index="${index}">
            ${option.text}
          </button>
        `).join('')}
      </div>
      <div class="lesson-feedback" id="lesson-feedback"></div>
    `

    this.panel.querySelectorAll('.lesson-option').forEach(button => {
      button.addEventListener('click', () => {
        this.answer(Number(button.dataset.index))
      })
    })
  }

  answer(index) {
    const lessons = this._buildLessons()
    const lesson = lessons[this.step]
    const option = lesson.options[index]
    const feedback = this.panel.querySelector('#lesson-feedback')

    this.panel.querySelectorAll('.lesson-option').forEach(button => {
      button.disabled = true
    })

    const speakText = LESSON_FEEDBACK_SPEECHES[option.correct ? 0 : 1]

    if (option.correct) {
      this.score += 1
      feedback.className = 'lesson-feedback correct'
      feedback.innerHTML = `<strong>判断正确</strong><p>${option.explanation || lesson.explanation}</p>`
    } else {
      feedback.className = 'lesson-feedback wrong'
      feedback.innerHTML = `<strong>还需要思考</strong><p>${option.explanation || lesson.explanation}</p>`
    }

    // 答题语音前先确保音频已解锁（用户可能刷新页面后直接点题）
    this.aiGuide.unlockVoice().finally(() => {
      this.aiGuide.say(speakText, 0, true)
    })

    this.onDecision?.({
      step: this.step,
      correct: option.correct,
      score: this.score
    })

    const nextButton = document.createElement('button')
    nextButton.className = 'lesson-next'
    nextButton.textContent = this.step === lessons.length - 1
      ? '查看学习结果'
      : '进入下一关'
    nextButton.addEventListener('click', () => {
      this.step += 1
      this.render()
    })
    this.panel.appendChild(nextButton)
  }

  renderSummary() {
    const lessons = this._buildLessons()
    this.panel.innerHTML = `
      <div class="lesson-complete">✓ 学习任务完成</div>
      <h3>你的救援决策能力</h3>
      <div class="lesson-score">${this.score} / ${lessons.length}</div>
      <p>你已经完成了从风险识别到路径决策的基础学习。现在可以播放 AI 训练回放，观察 AI 如何通过试错学会类似的决策。</p>
      <button class="lesson-next" id="restart-lesson">重新学习</button>
    `

    this.panel.querySelector('#restart-lesson')?.addEventListener('click', () => {
      this.start()
    })
  }

  /** 关闭互动面板，重置状态并通知外部 */
  close() {
    this.step = 0
    this.score = 0
    if (this.panel) {
      this.panel.innerHTML = '<div class="lesson-closed">点击上方"开始互动科普"继续学习</div>'
    }
    this.onDecision?.({
      step: 0,
      correct: false,
      score: 0,
      closed: true
    })
  }
}
