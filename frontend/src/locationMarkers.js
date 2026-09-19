import * as THREE from 'three'

/**
 * 地理标注模块（v2）—— 直接消费后端 hazard 数据
 *
 * 修复要点：
 *   - 彻底移除硬编码世界坐标与 flipZ 翻转
 *   - 所有标注位置统一通过 glbTerrain.gridToWorld(i, j) + getHeight(x, z) 推导
 *   - 数据源：hazard.landmarks.staging/trapped.grid + hazard.channel
 */
export class LocationMarkers {
  constructor(scene, terrain) {
    this.scene = scene
    this.terrain = terrain
    this.group = new THREE.Group()
    this.group.name = '场景地理标注'
    this.scene.add(this.group)
    this.markers = []
  }

  clear() {
    while (this.group.children.length > 0) {
      const obj = this.group.children[0]
      if (obj.geometry) obj.geometry.dispose()
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose())
        else obj.material.dispose()
      }
      this.group.remove(obj)
    }
    this.markers = []
  }

  /**
   * 根据当前后端 hazard 数据的 landmarks 动态生成真实地理标注
   * @param {object} hazard 后端返回的危险场数据
   */
  updateFromHazard(hazard) {
    this.clear()
    if (!hazard || !this.terrain) return

    const lm = hazard?.landmarks || {}
    const channel = hazard.channel || []

    // 1. 救援指挥所（安全高地，未受灾后方基地）
    const startGrid = lm.staging?.grid || [2, 4]
    const startPos = this._getSurfacePosition(startGrid[0], startGrid[1])
    this._createMarker('吉隆救援指挥所（前指安全高地）', startPos, 0x38bdf8, '#7dd3fc', startGrid)

    // 2. 泥石流物源区 · 主冲沟源头（高山冰川/崩滑堆积）
    if (channel.length > 0) {
      const head = channel[0]   // 源头：高处冰川融水/崩滑物源区
      const headPos = this._getSurfacePosition(head[0], head[1])
      this._createMarker('东林藏布·泥石流主冲沟（高山物源区）', headPos, 0xfb923c, '#fdba74', head)
    }

    // 3. 热索桥断桥位（主冲沟中部横切点）
    const bGrid = lm.bridge?.grid || [15, 13]
    const bPos = this._getSurfacePosition(bGrid[0], bGrid[1])
    this._createMarker('热索桥断桥（横切风险点）', bPos, 0xfacc15, '#fde047', bGrid)

    // 4. 受灾核心：吉隆口岸 · 热索桥（东南谷底堆积扇缘受灾点/失联被困点）
    const goalGrid = lm.trapped?.grid || [18, 15]
    const goalPos = this._getSurfacePosition(goalGrid[0], goalGrid[1])
    this._createMarker('吉隆口岸·热索桥（受灾核心区）', goalPos, 0xef4444, '#f87171', goalGrid)

    // 5. 后方应急避难点（安全）
    if (lm.shelter?.grid) {
      const shGrid = lm.shelter.grid
      const shPos = this._getSurfacePosition(shGrid[0], shGrid[1])
      this._createMarker('后方避难安置点', shPos, 0x34d399, '#6ee7b7', shGrid)
    }
  }

  _getSurfacePosition(i, j) {
    const x = Number(i)
    const z = Number(j)
    const gridSize = Number(this.terrain?.gridSize ?? 24)
    const isWorldCoordinate = !Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x > gridSize || z > gridSize

    if (isWorldCoordinate) {
      const world = new THREE.Vector3(x, 0, z)
      const y = (this.terrain.getHeight ? this.terrain.getHeight(world.x, world.z) : 0) + 0.15
      return new THREE.Vector3(world.x, y, world.z)
    }

    const world = this.terrain.gridToWorld(i, j)
    const y = (this.terrain.getHeight ? this.terrain.getHeight(world.x, world.z) : 0) + 0.15
    return new THREE.Vector3(world.x, y, world.z)
  }

  _createMarker(name, pos, colorHex, cssColor, grid = null) {
    const group = new THREE.Group()
    group.position.copy(pos)

    // 地面光晕环（放大）
    const ringGeo = new THREE.RingGeometry(0.5, 0.85, 48)
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2
    group.add(ring)

    // 竖直光柱（加粗加高）
    const lineGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 12)
    const lineMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.9
    })
    const line = new THREE.Mesh(lineGeo, lineMat)
    line.position.y = 0.8
    group.add(line)

    // 高层半透明悬浮提示球：作者瞄准/射线起点标记
    const glowGeo = new THREE.SphereGeometry(0.15, 16, 12)
    const glowMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.9
    })
    const glow = new THREE.Mesh(glowGeo, glowMat)
    glow.position.y = 1.6
    group.add(glow)

    // 自适应文字看板 Canvas：按文本长度动态缩字号，确保任意长短文字都不被边框裁切
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 240
    const ctx = canvas.getContext('2d')

    // 根据文本长度动态计算最佳字号（防止长文本被裁切）
    let fontSize = 68
    const maxAllowedWidth = canvas.width - 128   // 留出充足左右 padding
    ctx.font = `bold ${fontSize}px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
    let textMetrics = ctx.measureText(name)
    while (textMetrics.width > maxAllowedWidth && fontSize > 34) {
      fontSize -= 4
      ctx.font = `bold ${fontSize}px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
      textMetrics = ctx.measureText(name)
    }

    // 绘制深色半透明圆角底框 + 彩色描边
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(4, 16, 32, 0.88)'
    ctx.strokeStyle = cssColor
    ctx.lineWidth = 6
    const bx = 16, by = 16, bw = canvas.width - 32, bh = canvas.height - 32
    if (ctx.roundRect) {
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, 28)
      ctx.fill()
      ctx.stroke()
    } else {
      ctx.fillRect(bx, by, bw, bh)
      ctx.strokeRect(bx, by, bw, bh)
    }

    // 发光阴影（增强可读性）
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)'
    ctx.shadowBlur = 16
    ctx.shadowOffsetY = 3

    ctx.fillStyle = cssColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(name, canvas.width / 2, canvas.height / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true

    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.98,
      depthTest: false,      // 关闭深度测试，任意角度不被地形遮挡吞没
      depthWrite: false
    })
    const sprite = new THREE.Sprite(spriteMat)
    sprite.name = '地理标签'
    sprite.position.y = 2.1                       // 抬高，防近景地形遮蔽
    sprite.scale.set(7.5, 1.5, 1)                // 保持 5:1 宽高比，与 Canvas 一致
    group.add(sprite)

    this.group.add(group)
    this.markers.push({ group, ring, grid })
  }

  /**
   * 按当前地形高度重新贴地。
   * 地形起伏（setTerrainFactor）只缩放模型、不重建标注，所以变化后必须调用一次，
   * 否则标注会停在旧高度上（看起来悬在半空或埋进山里）。
   */
  refreshSurfacePositions() {
    for (const marker of this.markers) {
      if (!marker.grid) continue
      marker.group.position.copy(this._getSurfacePosition(marker.grid[0], marker.grid[1]))
    }
  }

  update(delta, time) {
    this.markers.forEach((m, idx) => {
      if (m.ring) {
        const scale = 1 + Math.sin(time * 3 + idx) * 0.15
        m.ring.scale.set(scale, scale, scale)
      }
    })
  }
}
