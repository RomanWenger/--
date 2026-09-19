import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export class AIGuide {
  constructor() {
    this.mesh = null
    this.time = 0
    this.currentMessage = ''
    // 默认开启语音：避免"忘了点语音按钮 → 所有 say() 被静默拦截"导致完全没声音
    this.voiceEnabled = true
    this.voiceUnlocked = false

    // 彻底移除浏览器原生 SpeechSynthesis，只用云端 AI 音色
    this.speechSynthesis = null

    // 核心：内存常驻高音质音频缓存池 (text -> Blob)
    this._audioBlobCache = new Map()
    this._prefetchingMap = new Map()

    this._queueVersion = 0
    this._streamAudio = null
    this._finishSpeech = null
    this._speechBusy = false
    this._isPlaying = false

    this.ttsUrl = '/api/tts'
    this.ttsStreamUrl = '/api/tts-stream'
    this._streamFirstChunkTimeout = 5000   // 流式端点多久没起播就切兜底
    this._ttsWarmed = false
    this._pinnedSpeech = new Set()   // 预加载过的讲词，缓存淘汰时跳过
    this._ttsConfigKey = ''          // 供浏览器缓存拼键：配置变了缓存自动失效
    this._ttsController = null

    // 短句队列：流式端点不可用时逐句合成，边播边取（低延迟兜底）
    this._sentenceCache = new Map()
    this._sentenceAbortController = null
    this._currentSource = null
    this._scheduledSources = null
    // 语速倍率：1.0 = MiMo 自然语速。调大更快，但逐句队列走 Web Audio，音调会略高；
    // 若改成非 1.0，blob/流式路径会保持音调不变（preservesPitch）。
    this.speechPlaybackRate = 1.0

    // 程序化动画状态（playNod / playWave 等动画依赖它，必须初始化）
    this.animState = { current: 'idle', timer: 0, duration: 0, progress: 0 }

    this._audioContext = null
    this.taskNarrationActive = false
    this.taskNarrationQueue = []

    this.onSpeechStart = null
    this.onSpeechEnd = null
    this.onSpeechError = null
    // 语音"真正出声"的那一刻回调（比 onSpeechStart 晚），3D 演示用它对齐动画
    this.onSpeechPlaying = null
    this._speechPlayingNotified = -1

    // 预加载进度（供 UI 显示"语音初始化中…"）
    this.onPreloadProgress = null
    this.preloadInFlight = false
    this.preloadDone = 0
    this.preloadTotal = 0

    // 语速估算：MiMo 冰糖音色长讲解实测约 5.0 字/秒，用于给动画配速
    this.speechCharsPerSecond = 5.0

    this._build()
  }

  _build() {
    const group = new THREE.Group()
    const bodyGroup = new THREE.Group()

    // 光环（与具体模型无关，保留）
    const glowGeo = new THREE.RingGeometry(0.6, 0.85, 32)
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide
    })
    this.glowRing = new THREE.Mesh(glowGeo, glowMat)
    this.glowRing.rotation.x = -Math.PI / 2
    // 光环贴近脚底（模型加载后底部归一化到 y=0）
    this.glowRing.position.set(0, 0.04, 0)
    group.add(this.glowRing)

    const glow2Geo = new THREE.RingGeometry(0.75, 1.05, 32)
    const glow2Mat = new THREE.MeshBasicMaterial({
      color: 0xfca5a5,
      transparent: true,
      opacity: 0.035,
      side: THREE.DoubleSide
    })
    this.glowRing2 = new THREE.Mesh(glow2Geo, glow2Mat)
    this.glowRing2.rotation.x = -Math.PI / 2
    this.glowRing2.position.set(0, 0.025, 0)
    group.add(this.glowRing2)

    // 不再创建对话气泡、思考气泡、闪烁粒子，避免遮挡角色头部

    group.add(bodyGroup)
    this.body = bodyGroup

    this.mesh = group
    // 放大 1.2 倍，注意不要裁掉腿脚；相机和容器已配合调整
    this.mesh.scale.setScalar(0.78 * 1.35 * 1.2)
    // AI agent 在独立渲染窗口中，居中显示
    this.mesh.position.set(0, 0, 0)
    this.mesh.rotation.y = 0
    this.mesh.userData.baseY = 0
    this.mesh.userData.baseX = 0
    this.mesh.userData.baseZ = 0
    this.mesh.userData.baseRotY = 0

    // 异步加载用户GLB模型
    this._loadModel()
  }

  _loadModel() {
    const loader = new GLTFLoader()
    // 使用 PBR 版本，光照效果更好
    loader.load(
      './models/ai_agent.glb',
      (gltf) => {
        const model = gltf.scene

        // 计算包围盒，自动缩放和居中
        const box = new THREE.Box3().setFromObject(model)
        const size = new THREE.Vector3()
        const center = new THREE.Vector3()
        box.getSize(size)
        box.getCenter(center)

        // 目标高度约 2.15 个单位
        const targetHeight = 2.15
        const scale = targetHeight / size.y
        model.scale.setScalar(scale)

        // 重新计算缩放后的包围盒以居中
        const scaledBox = new THREE.Box3().setFromObject(model)
        const scaledCenter = new THREE.Vector3()
        scaledBox.getCenter(scaledCenter)

        // 居中：让模型底部落在 y=0，中心在 x=0, z=0
        model.position.x -= scaledCenter.x
        model.position.z -= scaledCenter.z
        model.position.y -= scaledBox.min.y

        // 模型朝向：保持模型原始朝向，通过外层mesh的rotation来控制面向镜头
        // 不强制旋转模型本身
        model.rotation.set(0, 0, 0)

        this.body.add(model)
        this.modelRoot = model

        // 尝试按名称识别可动画部件
        this._findModelParts(model)

        // 停用模型自带动画，避免与程序化呼吸动作叠加导致晃动
        // if (gltf.animations && gltf.animations.length > 0) { ... }

        console.log('AI模型加载成功，部件数:', model.children.length)
      },
      (xhr) => {
        // 加载进度
        if (xhr.total) {
          const percent = (xhr.loaded / xhr.total * 100).toFixed(0)
          console.log(`AI模型加载中: ${percent}%`)
        }
      },
      (error) => {
        console.error('AI模型加载失败:', error)
        // 加载失败时回退到简单的占位几何体
        this._buildFallbackModel()
      }
    )
  }

  _findModelParts(root) {
    // 按常见命名规则查找头部、手臂等部件，key 必须与动画中使用的属性名一致
    const nameMap = {
      headGroup: ['head', '头', 'Head', 'HEAD'],
      leftArmGroup: ['leftarm', 'left_arm', 'arm_l', '左臂', 'LeftArm'],
      rightArmGroup: ['rightarm', 'right_arm', 'arm_r', '右臂', 'RightArm'],
      leftHand: ['lefthand', 'left_hand', 'hand_l', '左手'],
      rightHand: ['righthand', 'right_hand', 'hand_r', '右手'],
      leftFoot: ['leftfoot', 'left_foot', 'foot_l', '左脚'],
      rightFoot: ['rightfoot', 'right_foot', 'foot_r', '右脚']
    }

    root.traverse((child) => {
      if (!child.isMesh && !child.isGroup && !child.isBone) return
      const name = (child.name || '').toLowerCase().replace(/[\s_]/g, '')
      for (const [key, patterns] of Object.entries(nameMap)) {
        for (const pattern of patterns) {
          if (name.includes(pattern.toLowerCase().replace(/[\s_]/g, ''))) {
            this[key] = child
            break
          }
        }
      }
    })

    // 如果没找到独立的头部，就用整个模型作为"头部"来做点头动画
    if (!this.headGroup) {
      this.headGroup = root
    }
    // 手臂也用模型本身作为 fallback
    if (!this.leftArmGroup) this.leftArmGroup = null
    if (!this.rightArmGroup) this.rightArmGroup = null
  }

  _buildFallbackModel() {
    // GLB加载失败时的简单占位模型
    const fallback = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xfbbf24 })
    )
    fallback.position.y = 0.5
    this.body.add(fallback)
    this.modelRoot = fallback
    this.headGroup = fallback
  }

  _createSparkles() {
    const count = 20
    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(count * 3)
    this.sparkleData = []

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const radius = 0.55 + Math.random() * 0.75
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = (Math.random() - 0.15) * 1.7
      positions[i * 3 + 2] = Math.sin(angle) * radius
      this.sparkleData.push({
        speed: 0.2 + Math.random() * 0.75,
        offset: Math.random() * Math.PI * 2,
        radius: radius,
        angle: angle,
        yOffset: positions[i * 3 + 1],
        size: 0.012 + Math.random() * 0.028
      })
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const mat = new THREE.PointsMaterial({
      color: 0xfef3c7,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      size: 0.05
    })

    this.sparkleParticles = new THREE.Points(geo, mat)
    return this.sparkleParticles
  }

  _createThoughtBubbles() {
    const group = new THREE.Group()
    group.visible = false
    this.thoughtBubbleGroup = group

    const bubbleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.94
    })

    const b1 = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 12), bubbleMat)
    b1.position.set(0, 1.1, -0.28)
    group.add(b1)

    const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), bubbleMat)
    b2.position.set(0.1, 1.25, -0.33)
    group.add(b2)

    const b3 = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), bubbleMat)
    b3.position.set(0.27, 1.48, -0.38)
    group.add(b3)

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.width = 128
    canvas.height = 128
    ctx.font = 'bold 64px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('✨', 64, 70)

    const tex = new THREE.CanvasTexture(canvas)
    const iconMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide
    })
    const icon = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.27), iconMat)
    icon.position.set(0.27, 1.48, -0.16)
    group.add(icon)
    this.thoughtIcon = icon

    return group
  }

  _createSpeechBubble(parent) {
    const bubbleGroup = new THREE.Group()

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.width = 512
    canvas.height = 280

    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)'
    ctx.beginPath()
    const w = 500
    const h = 200
    const r = 55
    ctx.moveTo(r, 10)
    ctx.lineTo(w - r, 10)
    ctx.quadraticCurveTo(w, 10, w, 10 + r)
    ctx.lineTo(w, h - r)
    ctx.quadraticCurveTo(w, h, w - r, h)
    ctx.lineTo(r + 130, h)
    ctx.quadraticCurveTo(r + 108, h, r + 100, h + 12)
    ctx.lineTo(85, h + 55)
    ctx.lineTo(70, h + 12)
    ctx.quadraticCurveTo(65, h, r, h)
    ctx.quadraticCurveTo(0, h, 0, h - r)
    ctx.lineTo(0, 10 + r)
    ctx.quadraticCurveTo(0, 10, r, 10)
    ctx.fill()

    ctx.strokeStyle = '#dc2626'
    ctx.lineWidth = 6
    ctx.stroke()

    const bubbleTex = new THREE.CanvasTexture(canvas)
    const bubbleGeo = new THREE.PlaneGeometry(3.1, 1.7)
    const bubbleMat = new THREE.MeshBasicMaterial({
      map: bubbleTex,
      transparent: true,
      side: THREE.DoubleSide
    })
    const bubble = new THREE.Mesh(bubbleGeo, bubbleMat)
    bubble.position.set(1.75, 1.55, 0)
    bubbleGroup.add(bubble)
    this.bubbleMesh = bubble

    const textCanvas = document.createElement('canvas')
    textCanvas.width = 460
    textCanvas.height = 180
    const textTex = new THREE.CanvasTexture(textCanvas)
    const textGeo = new THREE.PlaneGeometry(2.8, 1.1)
    const textMat = new THREE.MeshBasicMaterial({
      map: textTex,
      transparent: true,
      side: THREE.DoubleSide
    })
    const textMesh = new THREE.Mesh(textGeo, textMat)
    textMesh.position.set(1.75, 1.55, 0.01)
    bubbleGroup.add(textMesh)
    this.textMesh = textMesh

    bubbleGroup.position.set(0, 0.5, 0)
    bubbleGroup.visible = false
    this.speechBubble = bubbleGroup

    parent.add(bubbleGroup)
  }

  _splitForSpeech(text) {
    const cleanText = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9，。！？、；：""''（）\s,.!?;:'"()]/g, '')
    
    const segments = []
    let current = ''
    
    const pauseRules = [
      { pattern: /[。！？!?]/g, pause: 'long' },
      { pattern: /[，；、,;]/g, pause: 'short' },
      { pattern: /[:：]/g, pause: 'medium' },
    ]
    
    const chars = cleanText.split('')
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]
      current += char
      
      let pauseType = null
      if (/[。！？!?]/.test(char)) pauseType = 'long'
      else if (/[，；、,;]/.test(char)) pauseType = 'short'
      else if (/[:：]/.test(char)) pauseType = 'medium'
      
      if (pauseType && current.trim().length > 6) {
        segments.push({ text: current.trim(), pause: pauseType })
        current = ''
      }
    }
    
    if (current.trim()) {
      segments.push({ text: current.trim(), pause: 'none' })
    }
    
    if (segments.length === 0) {
      segments.push({ text: cleanText.trim(), pause: 'none' })
    }
    
    return segments
  }

  _detectEmotion(text) {
    const lower = text.toLowerCase()
    if (text.includes('?') || text.includes('？') || lower.includes('什么') || lower.includes('为什么') || lower.includes('怎么') || lower.includes('呢') || lower.includes('如何')) {
      return 'curious'
    }
    if (text.includes('!') || text.includes('！') || lower.includes('太棒') || lower.includes('厉害') || lower.includes('专家') || lower.includes('🏆') || lower.includes('耶') || lower.includes('哇') || lower.includes('酷') || lower.includes('神奇')) {
      return 'excited'
    }
    if (lower.includes('思考') || lower.includes('学习') || lower.includes('让我') || lower.includes('嗯') || lower.includes('这个') || lower.includes('其实') || lower.includes('因为') || lower.includes('所以')) {
      return 'explaining'
    }
    if (lower.includes('欢迎') || lower.includes('你好') || lower.includes('嗨') || lower.includes('哈喽') || lower.includes('大家好')) {
      return 'happy'
    }
    if (lower.includes('注意') || lower.includes('小心') || lower.includes('危险') || lower.includes('重要')) {
      return 'serious'
    }
    return 'friendly'
  }

  _getVoiceParams(emotion, segmentIndex, totalSegments) {
    const baseRate = 0.68
    const basePitch = 1.15

    let rate = baseRate
    let pitch = basePitch
    let volume = 0.7

    switch (emotion) {
      case 'excited':
        rate = 0.78
        pitch = 1.20
        volume = 0.75
        break
      case 'happy':
        rate = 0.74
        pitch = 1.16
        volume = 0.72
        break
      case 'curious':
        rate = 0.66
        pitch = 1.16
        volume = 0.68
        break
      case 'explaining':
        rate = 0.62
        pitch = 1.10
        volume = 0.70
        break
      case 'serious':
        rate = 0.60
        pitch = 1.02
        volume = 0.72
        break
      case 'friendly':
      default:
        rate = 0.68
        pitch = 1.12
        volume = 0.70
        break
    }

    const progress = segmentIndex / Math.max(totalSegments - 1, 1)
    if (progress < 0.1) {
      rate *= 0.95
    }

    return { rate, pitch, volume }
  }

  /**
   * 解锁音频播放权限。必须在用户点击事件中调用。
   * 使用极短的静音振荡器完成解锁，统一走 Web Audio 链路。
   */
  async unlockVoice() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) {
        throw new Error('当前浏览器不支持 Web Audio API')
      }

      if (!this._audioContext) {
        this._audioContext = new AudioContextClass()
      }

      if (this._audioContext.state === 'suspended') {
        await this._audioContext.resume()
      }

      if (this._audioContext.state !== 'running') {
        throw new Error(`AudioContext 状态异常：${this._audioContext.state}`)
      }

      // 用极短的静音振荡器完成用户手势解锁（不产生可听声音）
      const oscillator = this._audioContext.createOscillator()
      const gain = this._audioContext.createGain()
      gain.gain.value = 0
      oscillator.connect(gain)
      gain.connect(this._audioContext.destination)

      const now = this._audioContext.currentTime
      oscillator.start(now)
      oscillator.stop(now + 0.02)

      this.voiceUnlocked = true
      this.voiceEnabled = true   // 解锁同时也启用语音
      console.log('AI语音已解锁:', this._audioContext.state)
      return true
    } catch (error) {
      this.voiceUnlocked = false
      console.error('AI语音解锁失败:', error)
      this.onSpeechError?.(error)
      return false
    }
  }

  stopSpeech() {
    this._queueVersion += 1
    this._isPlaying = false
    this._speechBusy = false

    if (this._sentenceAbortController) {
      this._sentenceAbortController.abort()
      this._sentenceAbortController = null
    }

    if (this._ttsController) {
      this._ttsController.abort()
      this._ttsController = null
    }

    if (this._finishSpeech) {
      this._finishSpeech(false)
      this._finishSpeech = null
    }

    if (this._currentSource) {
      try {
        this._currentSource.onended = null
        this._currentSource.stop()
        this._currentSource.disconnect()
      } catch (e) { /* 忽略 */ }
      this._currentSource = null
    }

    if (this._scheduledSources?.length) {
      for (const source of this._scheduledSources.splice(0)) {
        try { source.onended = null } catch (e) { /* 忽略 */ }
        try { source.stop() } catch (e) { /* 忽略 */ }
      }
    }
    this._scheduledSources = null

    if (this._streamAudio) {
      try {
        this._streamAudio.pause()
        this._streamAudio.removeAttribute('src')
        this._streamAudio.load()
      } catch (e) { /* 忽略 */ }
      this._streamAudio = null
    }
  }

  startTaskNarration() {
    this.taskNarrationActive = true
  }

  async stopTaskNarration() {
    this.taskNarrationActive = false
    const queued = this.taskNarrationQueue.splice(0)
    for (const item of queued) {
      await this.say(item.message, item.duration, item.useVoice, { interrupt: true })
    }
  }

  enqueueTaskNarration(message, duration = 0, useVoice = true) {
    const text = String(message ?? '').trim()
    if (text) this.taskNarrationQueue.push({ message: text, duration, useVoice })
  }

  toggleVoice() {
    // voiceEnabled 默认就是 true；首次点击（还没解锁过）应当视为"开启"而不是关掉，
    // 否则用户点"点击启用"反而会把语音关掉。解锁之后再按正常开关逻辑切换。
    this.voiceEnabled = this.voiceUnlocked ? !this.voiceEnabled : true
    if (!this.voiceEnabled) this.stopSpeech()
    return this.voiceEnabled
  }

  /**
   * 写入音频缓存池，超过上限时淘汰最早的条目（Blob 占内存，必须限量）
   */
  _cacheAudioBlob(text, blob, { pin = false } = {}) {
    if (!text || !blob) return
    this._audioBlobCache.set(text, blob)
    if (pin) this._pinnedSpeech.add(text)

    // 超出上限时淘汰最早的，但不动"钉住"的（初始化预加载的那些讲词）
    while (this._audioBlobCache.size > 12) {
      const victim = [...this._audioBlobCache.keys()]
        .find(key => key !== text && !this._pinnedSpeech.has(key))
      if (!victim) break
      this._audioBlobCache.delete(victim)
    }
  }

  /**
   * 静默预加载常用固定语音到内存（0 延迟的核心）
   */
  async preloadCommonSpeeches(textList = []) {
    const pending = textList
      .map(item => String(item ?? '').trim())
      .filter(text => text && !this._audioBlobCache.has(text))

    if (!pending.length) return

    // 并发 4：实测 6 条讲词总耗时从 24.7 秒降到 12.9 秒；再多收益有限，也怕把接口压垮
    const concurrency = Math.min(4, pending.length)
    this.preloadInFlight = true
    this.preloadDone = 0
    this.preloadTotal = pending.length
    console.log(`[TTS] 后台预加载 ${pending.length} 条常用语音（并发 ${concurrency}）...`)

    let cursor = 0

    const worker = async () => {
      while (cursor < pending.length) {
        const text = pending[cursor]
        cursor += 1
        try {
          const blob = await this._fetchSpeechForPreload(text)
          this._cacheAudioBlob(text, blob, { pin: true })
          if (blob) {
            this.preloadDone += 1
            this.onPreloadProgress?.(this.preloadDone, this.preloadTotal)
            console.log(`[TTS] 预加载就绪 ${this.preloadDone}/${this.preloadTotal}：「${text.slice(0, 12)}…」`)
          }
        } catch (error) {
          console.warn(`[TTS] 预加载失败：「${text.slice(0, 12)}…」`, error)
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
    } finally {
      this.preloadInFlight = false
      this.onPreloadProgress?.(this.preloadDone, this.preloadTotal)
      console.log(`[TTS] 预加载结束：${this.preloadDone}/${this.preloadTotal} 条已进内存缓存`)
    }
  }

  /**
   * 取当前 TTS 配置键（音色/模型/风格/格式）。用于拼浏览器缓存键：
   * 配置一变键就变，不会播到旧音色的缓存音频。
   */
  async _getTtsConfigKey() {
    if (this._ttsConfigKey) return this._ttsConfigKey
    try {
      const response = await fetch('/api/tts-config')
      if (response.ok) {
        const cfg = await response.json()
        this._ttsConfigKey = [cfg.provider, cfg.voice, cfg.model, cfg.style, cfg.format]
          .filter(Boolean).join('|')
      }
    } catch (e) { /* 忽略，退回默认键 */ }
    if (!this._ttsConfigKey) this._ttsConfigKey = 'default'
    return this._ttsConfigKey
  }

  /**
   * 预加载专用取音：走 GET /api/tts-stream（带配置键），
   * 命中浏览器缓存时几乎瞬间返回；失败再退回 POST 兜底。
   */
  async _fetchSpeechForPreload(text) {
    try {
      const key = await this._getTtsConfigKey()
      const url = `${this.ttsStreamUrl}?text=${encodeURIComponent(text)}&v=${encodeURIComponent(key)}`
      const response = await fetch(url)
      if (response.ok) {
        const blob = await response.blob()
        if (blob?.size) return blob
      }
    } catch (e) { /* 忽略，走兜底 */ }
    return await this._requestSpeechBlob(text)
  }

  /**
   * 确保某段讲词已经在缓存里（3D 演示等场景，避免现场合成导致开头仓促）。
   * 已有立即返回 true；没有则等待，最多等 timeoutMs。
   */
  async ensureSpeechCached(message, timeoutMs = 4000) {
    const text = String(message ?? '').trim()
    if (!text) return false
    if (this._audioBlobCache.has(text)) return true

    if (!this._prefetchingMap.has(text)) this.prefetchSpeech(text)
    const task = this._prefetchingMap.get(text)
    if (!task) return false

    const blob = await Promise.race([
      task,
      new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
    ])
    return Boolean(blob)
  }

  /**
   * 预取单条语音
   */
  prefetchSpeech(message) {
    const text = String(message ?? '').trim()
    if (!text || this._audioBlobCache.has(text) || this._prefetchingMap.has(text)) return
    const promise = this._requestSpeechBlob(text)
      .then(blob => {
        this._cacheAudioBlob(text, blob)
        this._prefetchingMap.delete(text)
        return blob
      })
      .catch(() => {
        this._prefetchingMap.delete(text)
        return null
      })
    this._prefetchingMap.set(text, promise)
  }

  /**
   * 按字数估算一段讲解的时长（秒）。
   * MiMo 冰糖音色实测约 5.6 字/秒（205 字 → 36.4 秒），用于给动画配速。
   */
  estimateSpeechDuration(message) {
    const text = String(message ?? '').replace(/\s+/g, '')
    if (!text) return 0
    const rate = this.speechPlaybackRate || 1
    // 实测约 5.0 字/秒（187 字 → 约 37 秒），再按语速倍率折算
    return (text.length / this.speechCharsPerSecond) / rate
  }

  /**
   * 通知外部"语音真正开始出声了"；同一次播报只通知一次。
   */
  _notifySpeechPlaying(version) {
    if (this._speechPlayingNotified === version) return
    this._speechPlayingNotified = version
    this.onSpeechPlaying?.()
  }

  /**
   * 播报语音：100% 使用高品质云端 AI 音频
   * - 内存已缓存：0 毫秒即刻播放
   * - 内存未缓存：流式边下边播，同时写入缓存备用
   */
  async say(message, duration = 0, useVoice = true, force = false) {
    const text = String(message ?? '').trim()
    if (!text) return false

    const options = force && typeof force === 'object'
      ? force
      : { interrupt: Boolean(force) }
    const interrupt = options.interrupt === true

    if (this.taskNarrationActive && !interrupt) {
      this.enqueueTaskNarration(text, duration, useVoice)
      return false
    }

    // 同一段话正在播时不要重头再播（否则会听到开头被念两遍）
    if (this._isPlaying && this.currentMessage === text && !interrupt) {
      return true
    }

    this.stopSpeech()
    this.currentMessage = text
    this._isPlaying = true

    if (typeof this.onSpeechStart === 'function') {
      this.onSpeechStart(text)
    }

    if (!useVoice || !this.voiceEnabled) {
      this._isPlaying = false
      this.onSpeechEnd?.(text, false)
      return false
    }

    const version = ++this._queueVersion
    const startedAt = performance.now()
    this._speechBusy = true

    const speakEnded = (success) => {
      if (version === this._queueVersion) {
        this._isPlaying = false
        this._speechBusy = false
        this.onSpeechEnd?.(text, success)
      }
      return success
    }

    try {
      // 1. 内存缓存命中：0 延迟直接播
      let blob = this._audioBlobCache.get(text)

      // 2. 有预取在跑：最多等 400ms，等不到就先走流式（音频仍会进缓存，下次瞬间播）
      if (!blob && this._prefetchingMap.has(text)) {
        blob = await Promise.race([
          this._prefetchingMap.get(text),
          new Promise(resolve => setTimeout(() => resolve(null), 400))
        ])
      }

      if (blob && version === this._queueVersion) {
        console.log('[TTS] 缓存命中起播:', Math.round(performance.now() - startedAt), 'ms', '「' + text.slice(0, 12) + '」')
        return speakEnded(await this._playBlobAudio(blob, version))
      }

      // 长文本直接走短句队列：整段合成约 0.14 秒/字（40 字要 ~6 秒），
      // 而逐句合成 1~2 秒就能出声；短文本才值得用流式端点。
      const preferQueue = options.preferSentences === true || text.length > 18
      if (preferQueue && this._audioContext) {
        const presetSentences = this._splitSpeechText(text)
        if (presetSentences.length > 1) {
          this._sentenceAbortController = new AbortController()
          try {
            const ok = await this._playSentenceQueue(presetSentences, version, startedAt)
            if (version !== this._queueVersion) return false
            if (ok) return speakEnded(true)
          } catch (error) {
            if (error?.name !== 'AbortError') {
              console.warn('[TTS] 短句队列失败，改用兜底链路:', error)
            }
          }
        }
      }

      // 3. 流式端点：整段合成，只有短文本才划算（长文本整段要等好几秒）
      if (text.length <= 18) {
        const streamResult = await this._playStreamedAudio(text, version)
        if (version !== this._queueVersion) return false
        if (streamResult.ok) return speakEnded(true)
        // 已经出过声就不再换链路重播，避免同一段听两遍
        if (streamResult.started) {
          console.warn('[TTS] 流式播放中断，本段不再重播')
          return speakEnded(false)
        }
      }

      // 4. 短句队列：流式不可用时逐句合成，首句就出声
      const sentences = this._splitSpeechText(text)
      if (this._audioContext && sentences.length) {
        this._sentenceAbortController = new AbortController()
        try {
          const ok = await this._playSentenceQueue(sentences, version, startedAt)
          if (version !== this._queueVersion) return false
          if (ok) return speakEnded(true)
        } catch (error) {
          if (error?.name !== 'AbortError') {
            console.warn('[TTS] 短句队列失败，改用整段兜底:', error)
          }
        }
      }

      // 5. 整段兜底：POST /api/tts 拿完整音频，同时写入缓存
      blob = await this._requestSpeechBlob(text, { track: true })
      if (version !== this._queueVersion) return false
      if (blob) {
        this._cacheAudioBlob(text, blob)
        return speakEnded(await this._playBlobAudio(blob, version))
      }

      console.warn('[TTS] 所有语音链路均失败，本段没有声音')
      this.onSpeechError?.(new Error('TTS_FETCH_FAILED'))
      return speakEnded(false)
    } catch (error) {
      if (error?.name === 'AbortError') return false
      console.error('AI语音播放异常:', error)
      this.onSpeechError?.(error)
      return speakEnded(false)
    } finally {
      if (version === this._queueVersion) {
        this._speechBusy = false
        this._isPlaying = false
      }
    }
  }

  /**
   * 播放 Blob 音频（从内存直接播放，无网络等待）
   */
  _playBlobAudio(blob, version) {
    return new Promise(resolve => {
      if (version !== this._queueVersion) {
        resolve(false)
        return
      }

      let settled = false
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.preload = 'auto'
      audio.volume = 0.85
      audio.playbackRate = this.speechPlaybackRate || 1
      audio.preservesPitch = true
      this._streamAudio = audio

      const cleanup = () => {
        if (settled) return
        settled = true
        audio.onended = null
        audio.onerror = null
        try { audio.pause() } catch (e) {}
        URL.revokeObjectURL(url)
        if (this._streamAudio === audio) this._streamAudio = null
        if (this._finishSpeech === finish) this._finishSpeech = null
      }

      const finish = (success) => {
        cleanup()
        resolve(success && version === this._queueVersion)
      }

      this._finishSpeech = finish
      audio.onended = () => finish(true)
      audio.onerror = () => finish(false)

      // 起播位置检查：只看第一次起播，且阈值放宽。
      // 注意：playing 事件回调本身可能因主线程繁忙而延迟，阈值太小会把正常起播
      // 误判成"跳过开头"，然后反复拉回开头（听感就是重复、波动、像两个人在说话）。
      let startChecked = false
      audio.onplaying = () => {
        if (startChecked) return
        startChecked = true
        if (audio.currentTime > 1.2) {
          console.warn('[TTS] 起播位置明显偏后，回到开头:', audio.currentTime.toFixed(2), 's')
          try { audio.currentTime = 0 } catch (e) { /* 忽略 */ }
        }
      }

      // 等浏览器把这段音频准备好再起播：主线程繁忙时"边解码边播"可能从中途开始，
      // 听感就是开头被吞（本地 blob 通常几十毫秒就绪，几乎无感）
      const startPlayback = () => {
        audio.play().then(() => {
          this._notifySpeechPlaying(version)
        }).catch(error => {
          if (error?.name !== 'AbortError') console.warn('[TTS] 音频播放受阻:', error)
          finish(false)
        })
      }

      if (audio.readyState >= 3) {
        startPlayback()
      } else {
        let startTriggered = false
        const readyToStart = () => {
          if (startTriggered || settled) return
          startTriggered = true
          startPlayback()
        }
        audio.oncanplay = readyToStart
        audio.oncanplaythrough = readyToStart
        setTimeout(readyToStart, 1200)
      }
    })
  }

  /**
   * 流式播放：直连 /api/tts-stream，首包即播。
   * resolve { ok, started }：started=true 表示已经出过声（失败时不再换链路重播）。
   */
  _playStreamedAudio(text, version) {
    return new Promise((resolve) => {
      if (version !== this._queueVersion) {
        resolve({ ok: false, started: false })
        return
      }

      let settled = false
      let started = false
      let lastTime = 0
      let lastProgressAt = Date.now()

      const audio = new Audio()
      audio.preload = 'auto'
      audio.volume = 0.85
      audio.playbackRate = this.speechPlaybackRate || 1
      audio.preservesPitch = true

      const cleanup = () => {
        if (settled) return
        settled = true
        clearTimeout(firstChunkTimer)
        clearInterval(stallTimer)
        audio.onplaying = null
        audio.onended = null
        audio.onerror = null
        try { audio.pause() } catch (e) { /* 忽略 */ }
        try {
          audio.removeAttribute('src')
          audio.load()
        } catch (e) { /* 忽略 */ }
        if (this._streamAudio === audio) this._streamAudio = null
        if (this._finishSpeech === finish) this._finishSpeech = null
      }

      const finish = (success) => {
        cleanup()
        resolve({ ok: success && version === this._queueVersion, started })
      }

      // 流式端点迟迟不出声（不存在 / 挂住）时切兜底，不能让调用方一直等
      const firstChunkTimer = setTimeout(() => {
        if (started) return
        console.warn(`[TTS] 流式端点 ${this._streamFirstChunkTimeout}ms 未起播，改用兜底链路`)
        finish(false)
      }, this._streamFirstChunkTimeout)

      // 中途断流保护
      const stallTimer = setInterval(() => {
        if (settled || audio.ended) return
        if (audio.currentTime > lastTime + 0.05) {
          lastTime = audio.currentTime
          lastProgressAt = Date.now()
          return
        }
        if (Date.now() - lastProgressAt > 15000) {
          console.warn('[TTS] 流式播放停滞超过 15s，主动收尾')
          finish(false)
        }
      }, 3000)

      this._finishSpeech = finish
      this._streamAudio = audio

      audio.onplaying = () => {
        started = true
        lastProgressAt = Date.now()
        console.log('[TTS] 流式音频首包已起播')
        this._notifySpeechPlaying(version)
      }
      audio.onended = () => finish(true)
      audio.onerror = () => {
        console.warn('[TTS] 流式播放中断')
        finish(false)
      }

      audio.src = `${this.ttsStreamUrl}?text=${encodeURIComponent(text)}`
      audio.play().catch(err => {
        if (err?.name !== 'AbortError') console.warn('[TTS] 流式起播拦截:', err)
        finish(false)
      })
    })
  }

  /**
   * 请求整段语音（POST /api/tts），返回 Blob 或 null。
   * track=true 时挂到 this._ttsController，stopSpeech() 可以中止它。
   */
  async _requestSpeechBlob(text, { track = false, timeoutMs = 60000 } = {}) {
    const controller = new AbortController()
    if (track) this._ttsController = controller
    // 长讲解整段合成需要 20~30 秒，超时时间放宽；短句走的是另一条链路（无此超时）
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(this.ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, emotion: 'explaining' }),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`TTS 请求失败 ${response.status}`)
      }
      const blob = await response.blob()
      return blob?.size ? blob : null
    } catch (e) {
      return null
    } finally {
      clearTimeout(timeoutId)
      if (track && this._ttsController === controller) {
        this._ttsController = null
      }
    }
  }

  /**
   * 中文语音短句切分：按标点切句，过长段落再按 80 字硬切。
   */
  _splitSpeechText(text) {
    const normalized = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!normalized) return []

    // 先按句末标点切，再按逗号/顿号细分，最后把过短片段合并到 22 字左右：
    // 块越短首句合成越快（出声更早），块太长则单句等待久。
    const sentences = normalized
      .split(/(?<=[。！？!?；;])\s*/)
      .map(item => item.trim())
      .filter(Boolean)

    const result = []
    for (const sentence of sentences) {
      const pieces = sentence
        .split(/(?<=[，,、])\s*/)
        .map(item => item.trim())
        .filter(Boolean)

      let buffer = ''
      for (const piece of pieces) {
        if (buffer && buffer.length + piece.length > 22) {
          result.push(buffer)
          buffer = piece
        } else {
          buffer += piece
        }
      }
      if (buffer) result.push(buffer)
    }

    const chunks = []
    for (const part of result) {
      if (part.length <= 60) {
        chunks.push(part)
        continue
      }
      for (let i = 0; i < part.length; i += 60) {
        chunks.push(part.slice(i, i + 60))
      }
    }
    return chunks
  }

  /**
   * 请求单句音频（带缓存 + 版本校验 + 取消）。
   * 偶发的连接卡顿/超时会自动重试一次，避免整段讲解因为一句失败而中断。
   */
  async _fetchSentenceAudio(text, version, attempt = 0) {
    if (version !== this._queueVersion) {
      throw new DOMException('speech cancelled', 'AbortError')
    }

    if (this._sentenceCache.has(text)) {
      return this._sentenceCache.get(text).slice(0)
    }

    const signal = this._sentenceAbortController
      ? this._sentenceAbortController.signal
      : undefined

    try {
      const response = await fetch(this.ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal
      })

      if (!response.ok) {
        throw new Error(`TTS 请求失败 ${response.status}`)
      }

      const arrayBuffer = await response.arrayBuffer()
      if (!arrayBuffer.byteLength) {
        throw new Error('TTS 返回空音频')
      }

      this._sentenceCache.set(text, arrayBuffer.slice(0))
      while (this._sentenceCache.size > 120) {
        this._sentenceCache.delete(this._sentenceCache.keys().next().value)
      }
      return arrayBuffer
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      if (attempt >= 1) throw error

      console.warn('[TTS] 短句请求失败，300ms 后重试一次:', error?.message || error)
      await new Promise(resolve => setTimeout(resolve, 300))
      if (version !== this._queueVersion) {
        throw new DOMException('speech cancelled', 'AbortError')
      }
      return await this._fetchSentenceAudio(text, version, attempt + 1)
    }
  }

  /**
   * 短句顺序播放队列：逐句「请求 + 解码 + 排程」，无缝连播。
   *
   * 无缝的三个要点：
   *  1. 用 Web Audio 时钟排程（source.start(时间点)），句与句之间不留 JS 调度的缝隙；
   *  2. 保留 MiMo 自己合成的自然停顿，不做裁剪（早先按阈值裁首尾静音，
   *     实测会把某些句子缓慢上升的起音削掉约 50ms，听起来像"吞字"，已去掉）；
   *  3. 预取失败不致命：轮到该句时会重试，重试仍失败就跳过，不打断整段讲解。
   */
  async _playSentenceQueue(sentences, version, startedAt = 0) {
    if (this._audioContext?.state === 'suspended') {
      try { await this._audioContext.resume() } catch (e) { /* 忽略 */ }
    }
    if (this._audioContext?.state !== 'running') {
      throw new Error(`音频上下文无法运行：${this._audioContext?.state || 'unavailable'}`)
    }

    const ctx = this._audioContext
    const rate = this.speechPlaybackRate || 1
    const sources = []
    let scheduledUntil = 0
    let skipped = 0

    this._scheduledSources = sources

    try {
      for (let index = 0; index < sentences.length; index += 1) {
        if (version !== this._queueVersion) return false

        // 预取后面两句（失败只记日志，轮到它时会重试）
        for (let ahead = 1; ahead <= 2; ahead += 1) {
          if (index + ahead < sentences.length) {
            this._fetchSentenceAudio(sentences[index + ahead], version).catch(() => null)
          }
        }

        let arrayBuffer = null
        try {
          arrayBuffer = await this._fetchSentenceAudio(sentences[index], version)
        } catch (error) {
          if (error?.name === 'AbortError') return false
          skipped += 1
          console.warn('[TTS] 这一句没能取到音频，跳过继续:', error?.message || error)
          continue
        }
        if (version !== this._queueVersion) return false

        let buffer = null
        try {
          buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
        } catch (error) {
          skipped += 1
          console.warn('[TTS] 这一句解码失败，跳过继续:', error)
          continue
        }
        if (version !== this._queueVersion) return false

        const source = ctx.createBufferSource()
        const gain = ctx.createGain()
        source.buffer = buffer
        source.playbackRate.value = rate
        gain.gain.value = 0.95
        source.connect(gain)
        gain.connect(ctx.destination)

        if (index === 0 && startedAt) {
          console.log('[TTS] 首句开始播放:', Math.round(performance.now() - startedAt), 'ms')
        }

        // 第一句多留一点排程余量，避免主线程繁忙时起播位置被跳过
        const leadIn = index === 0 ? 0.12 : 0.03
        const startAt = Math.max(ctx.currentTime + leadIn, scheduledUntil)
        source.start(startAt)
        scheduledUntil = startAt + buffer.duration / rate
        sources.push(source)
        this._notifySpeechPlaying(version)
      }

      if (!sources.length) return false

      // 等最后一句播完；被 stopSpeech 打断时立即收尾
      const played = await new Promise(resolve => {
        let done = false
        const complete = value => {
          if (done) return
          done = true
          resolve(value)
        }
        const last = sources[sources.length - 1]
        last.onended = () => complete(true)
        this._finishSpeech = () => {
          for (const item of sources) {
            try { item.onended = null } catch (e) { /* 忽略 */ }
            try { item.stop() } catch (e) { /* 忽略 */ }
          }
          complete(false)
        }
      })

      if (skipped) console.warn(`[TTS] 本段有 ${skipped} 句没能播放`)
      return played && version === this._queueVersion
    } finally {
      // 只有"当前这一轮"才能清理状态，否则旧的一轮会把新一轮的
      // 排程列表/中止器清掉，导致新一轮的音频没人能停（叠着播）
      if (version === this._queueVersion) {
        this._scheduledSources = null
        this._finishSpeech = null
        this._sentenceAbortController = null
      }
    }
  }

  /**
   * 预热 TTS 链路（连接与引擎冷启动）。开启语音后调用一次即可，失败静默忽略。
   */
  warmUpTTS() {
    if (this._ttsWarmed) return
    this._ttsWarmed = true
    const text = '你好'
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    fetch(`${this.ttsStreamUrl}?text=${encodeURIComponent(text)}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`预热失败 ${response.status}`)
        const reader = response.body?.getReader?.()
        if (!reader) return
        try { await reader.read() } catch (e) { /* 忽略 */ }
        try { await reader.cancel() } catch (e) { /* 忽略 */ }
      })
      .catch(() => this._requestSpeechBlob(text).catch(() => null))
      .finally(() => clearTimeout(timeoutId))
  }

  _playEmotionAnim(emotion) {
    switch (emotion) {
      case 'curious':
        this.playCurious()
        break
      case 'excited':
        this.playExcited()
        break
      case 'explaining':
        this.playExplaining()
        break
      case 'happy':
        this.playWave()
        break
      case 'serious':
        this.playSerious()
        break
      default:
        this.playNod()
    }
  }

  _startAnim(name, duration) {
    this.animState.current = name
    this.animState.timer = 0
    this.animState.duration = duration
    this.animState.progress = 0
  }

  _easeOutElastic(t) {
    if (t === 0) return 0
    if (t === 1) return 1
    return Math.pow(2, -10 * t) * Math.sin((t - 0.1) * 5 * Math.PI) + 1
  }

  _easeOutBounce(t) {
    if (t < 1 / 2.75) {
      return 7.5625 * t * t
    } else if (t < 2 / 2.75) {
      t -= 1.5 / 2.75
      return 7.5625 * t * t + 0.75
    } else if (t < 2.5 / 2.75) {
      t -= 2.25 / 2.75
      return 7.5625 * t * t + 0.9375
    } else {
      t -= 2.625 / 2.75
      return 7.5625 * t * t + 0.984375
    }
  }

  _easeOutBack(t) {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  }

  playWave() { this._startAnim('wave', 1.8) }
  playNod() { this._startAnim('nod', 1.2) }

  playExplaining() {
    this._startAnim('explaining', 3.0)
    if (this.thoughtBubbleGroup) {
      this.thoughtBubbleGroup.visible = true
      if (this.thoughtIcon) {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        canvas.width = 128
        canvas.height = 128
        ctx.font = 'bold 64px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('💡', 64, 70)
        const tex = new THREE.CanvasTexture(canvas)
        this.thoughtIcon.material.map = tex
        this.thoughtIcon.material.needsUpdate = true
      }
    }
  }

  playCurious() {
    this._startAnim('curious', 2.5)
    if (this.thoughtBubbleGroup) {
      this.thoughtBubbleGroup.visible = true
      if (this.thoughtIcon) {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        canvas.width = 128
        canvas.height = 128
        ctx.font = 'bold 64px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('❓', 64, 70)
        const tex = new THREE.CanvasTexture(canvas)
        this.thoughtIcon.material.map = tex
        this.thoughtIcon.material.needsUpdate = true
      }
    }
  }

  playExcited() { this._startAnim('excited', 1.8) }
  playSerious() { this._startAnim('serious', 1.5) }

  _updateAnim(delta) {
    const s = this.animState
    if (s.current === 'idle') return

    s.timer += delta
    s.progress = Math.min(s.timer / s.duration, 1)

    switch (s.current) {
      case 'wave': this._updateWave(s.progress); break
      case 'nod': this._updateNod(s.progress); break
      case 'explaining': this._updateExplaining(s.progress); break
      case 'curious': this._updateCurious(s.progress); break
      case 'excited': this._updateExcited(s.progress); break
      case 'serious': this._updateSerious(s.progress); break
    }

    if (s.progress >= 1) {
      if (s.current === 'explaining' || s.current === 'curious') {
        if (this.thoughtBubbleGroup) this.thoughtBubbleGroup.visible = false
      }
      s.current = 'idle'
    }
  }

  _updateWave(p) {
    const waveAngle = Math.sin(p * Math.PI * 4) * 0.7
    const ease = this._easeOutBack(p)

    // 如果有独立手臂，挥动手臂；否则用身体倾斜模拟
    if (this.rightArmGroup) {
      this.rightArmGroup.rotation.z = -0.25 - 1.5 * ease + waveAngle * (1 - ease * 0.4)
      this.rightArmGroup.rotation.x = -0.5 * ease
      this.rightArmGroup.position.y = 0.05 + 0.15 * ease
      if (this.rightHand) this.rightHand.scale.setScalar(1 + Math.sin(p * Math.PI * 4) * 0.25)
    }

    if (this.body) {
      this.body.rotation.z = Math.sin(p * Math.PI * 2) * 0.08 * ease
      this.body.rotation.y = Math.sin(p * Math.PI * 2) * 0.1 * ease
    }
    if (this.headGroup) {
      this.headGroup.rotation.z = Math.sin(p * Math.PI * 3) * 0.06 * ease
    }
  }

  _updateNod(p) {
    if (!this.headGroup) return
    const nodCount = 2
    const nodAngle = Math.sin(p * Math.PI * 2 * nodCount) * 0.18
    const ease = p < 0.1 ? p / 0.1 : p > 0.9 ? (1 - p) / 0.1 : 1

    this.headGroup.rotation.x = nodAngle * ease
    if (this.body) this.body.rotation.x = nodAngle * 0.3 * ease
  }

  _updateExplaining(p) {
    if (!this.headGroup) return
    const tilt = Math.sin(p * Math.PI * 2) * 0.1
    this.headGroup.rotation.z = tilt
    this.headGroup.position.y = (this.headGroup.userData.baseY || 0) + Math.sin(p * Math.PI * 3) * 0.03

    if (this.rightArmGroup) {
      this.rightArmGroup.rotation.z = -0.25 - Math.sin(p * Math.PI * 3) * 0.4
      this.rightArmGroup.rotation.x = -0.3 + Math.sin(p * Math.PI * 2) * 0.2
    }

    if (this.thoughtBubbleGroup) {
      this.thoughtBubbleGroup.position.y = Math.sin(p * Math.PI * 5) * 0.05
      this.thoughtBubbleGroup.rotation.z = Math.sin(p * Math.PI * 2) * 0.1
    }

    if (this.body) {
      this.body.rotation.z = Math.sin(p * Math.PI * 2) * 0.04
    }
  }

  _updateCurious(p) {
    if (!this.headGroup) return
    const tilt = Math.sin(p * Math.PI * 2.5) * 0.12
    this.headGroup.rotation.z = tilt
    this.headGroup.position.y = (this.headGroup.userData.baseY || 0) + Math.sin(p * Math.PI * 5) * 0.035

    if (this.thoughtBubbleGroup) {
      this.thoughtBubbleGroup.position.y = Math.abs(Math.sin(p * Math.PI * 7)) * 0.09
      this.thoughtBubbleGroup.rotation.z = Math.sin(p * Math.PI * 5) * 0.14
    }

    if (this.body) {
      this.body.rotation.z = Math.sin(p * Math.PI * 3) * 0.04
    }
  }

  _updateSerious(p) {
    if (!this.headGroup) return
    const ease = p < 0.1 ? p / 0.1 : p > 0.9 ? (1 - p) / 0.1 : 1

    this.headGroup.rotation.x = -0.08 * ease
    if (this.body) this.body.rotation.x = -0.04 * ease

    if (this.rightArmGroup && this.leftArmGroup) {
      this.rightArmGroup.rotation.z = -0.25 - 0.2 * ease
      this.leftArmGroup.rotation.z = 0.25 + 0.2 * ease
    }
  }

  _updateExcited(p) {
    const bounce = this._easeOutBounce(p) * 0.25
    if (this.body) this.body.position.y = bounce

    if (this.rightArmGroup && this.leftArmGroup) {
      const armUp = bounce * 2.5
      this.rightArmGroup.rotation.z = -0.25 - armUp
      this.leftArmGroup.rotation.z = 0.25 + armUp
    }

    if (this.headGroup) this.headGroup.rotation.z = Math.sin(p * Math.PI * 4) * 0.08

    if (this.glowRing) {
      const s = 1 + bounce * 0.5
      this.glowRing.scale.setScalar(s)
    }
  }

  _updateBubbleText(text) {
    if (!this.textMesh) return
    const canvas = this.textMesh.material.map.image
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    ctx.fillStyle = '#1e293b'
    ctx.font = 'bold 20px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    const maxWidth = 420
    const lineHeight = 30
    const x = 20
    let y = 12
    const chars = text.split('')
    let line = ''

    for (let i = 0; i < chars.length; i++) {
      const testLine = line + chars[i]
      const metrics = ctx.measureText(testLine)
      if (metrics.width > maxWidth && i > 0) {
        ctx.fillText(line, x, y)
        line = chars[i]
        y += lineHeight
      } else {
        line = testLine
      }
    }
    ctx.fillText(line, x, y)
    this.textMesh.material.map.needsUpdate = true
  }

  update(delta, time) {
    this.time = time
    if (!this.mesh) return

    const data = this.mesh.userData

    // 角色站稳：不平移、不转头、不左右晃动
    this.mesh.position.set(
      data.baseX ?? 0,
      data.baseY ?? 0,
      data.baseZ ?? 0
    )
    this.mesh.rotation.set(0, data.baseRotY ?? 0, 0)

    if (this.body) {
      this.body.position.set(0, 0, 0)
      this.body.rotation.set(0, 0, 0)
      // 仅保留约 0.2% 的轻微呼吸起伏
      this.body.scale.set(
        1,
        1 + Math.sin(time * 1.1) * 0.002,
        1
      )
    }

    // 光环保持稳定，不旋转，仅允许极小幅度的呼吸感
    if (this.glowRing) {
      this.glowRing.rotation.z = 0
      this.glowRing.scale.setScalar(
        1 + Math.sin(time * 0.8) * 0.008
      )
    }

    if (this.glowRing2) {
      this.glowRing2.rotation.z = 0
      this.glowRing2.scale.setScalar(
        1.02 + Math.sin(time * 0.7 + 1.2) * 0.006
      )
    }
  }
}
