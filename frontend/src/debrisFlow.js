import * as THREE from 'three'

/**
 * 泥石流可视化层 v2 —— 自适应河道带 + 纹理滚动 + 级联粒子 + 翻滚巨石
 *
 * 视觉结构：
 *   1. mudRibbon  沿主冲沟的连续贴地泥浆带（带流动贴图 + UV 滚动）
 *   2. particles  沿沟道快速下泻的泥砂粒子流
 *   3. boulders   伴随泥流沿沟道翻滚的巨石
 *
 * 全部位置由 glbTerrain.gridToWorld / getHeight 推导，无硬编码世界坐标。
 */
export class DebrisFlow {
  constructor(gridSize = 8, cellSize = 1.8, glbTerrain = null) {
    this.gridSize = gridSize
    this.cellSize = cellSize
    this.glbTerrain = glbTerrain

    this.flowIntensity = 0.5
    this.displayIntensity = 1.0
    this.hazard = null
    this.time = 0

    this.group = new THREE.Group()
    this.group.name = '泥石流动态系统'

    this._flowTexture = this._generateMudTexture()
    this._channelPts = []
    this._channelCurve = null

    this.mudRibbon = null
    this.particles = null
    this.particleData = []
    this.boulders = null
    this._baseOpacities = new Map()
  }

  // 生成混合泥沙纹理：深色湿泥、浅色泥沫和沿流向的细微拉丝
  _generateMudTexture() {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const ctx = canvas.getContext('2d')

    ctx.fillStyle = 'rgba(82, 52, 27, 0.76)'
    ctx.fillRect(0, 0, 512, 512)

    for (let i = 0; i < 105; i++) {
      const alpha = 0.14 + Math.random() * 0.28
      ctx.fillStyle = Math.random() > 0.42
        ? `rgba(157, 103, 48, ${alpha})`
        : `rgba(48, 32, 20, ${alpha})`
      const x = Math.random() * 512
      const w = 3 + Math.random() * 15
      ctx.fillRect(x, 0, w, 512)
    }

    for (let i = 0; i < 52; i++) {
      ctx.fillStyle = `rgba(214, 176, 112, ${0.12 + Math.random() * 0.22})`
      const x = Math.random() * 512
      const y = Math.random() * 512
      ctx.beginPath()
      ctx.ellipse(
        x, y, 5 + Math.random() * 18, 3 + Math.random() * 10,
        (Math.random() - 0.5) * 0.35, 0, Math.PI * 2
      )
      ctx.fill()
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.premultiplyAlpha = true
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(2, 6)
    return texture
  }

  rebuildFromHazard(hz) {
    this.hazard = hz
    this._clear()

    // 强度为 0（或近乎无）时：整条泥石流（主带/粒子/巨石/堆积扇）全部隐藏，
    // 真正做到"调强度到 0 就没有泥石流"
    const intensity = this._getIntensity()
    if (!hz || !hz.channel || hz.channel.length < 2 || intensity <= 0.001) {
      this.group.visible = intensity > 0.001
      return
    }
    this.group.visible = true

    this._buildChannelCurve()
    this._buildDepositFan()      // 堆积扇：冲沟末端向河谷/口岸扇形铺开 → 体现淤埋
    this._buildMudRibbon()       // 主流带
    this._buildCascadeParticles()
    this._buildRollingBoulders()
    this._recordBaseOpacities()
  }

  // 兼容旧接口（terrain 加载完成后被调用）
  updateRibbonHeight() {
    if (this.hazard) this.rebuildFromHazard(this.hazard)
  }

  rebuildFromTerrain() {
    if (this.hazard) this.rebuildFromHazard(this.hazard)
  }

  _clear() {
    while (this.group.children.length > 0) {
      const obj = this.group.children[0]
      if (obj.traverse) {
        obj.traverse(c => {
          if (c.geometry) c.geometry.dispose()
          if (c.material) {
            if (Array.isArray(c.material)) c.material.forEach(m => m.dispose())
            else c.material.dispose()
          }
        })
      } else {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose())
          else obj.material.dispose()
        }
      }
      this.group.remove(obj)
    }
    this.mudRibbon = null
    this.particles = null
    this.particleData = []
    this.boulders = null
    this.depositFan = null
    this._baseOpacities.clear()
  }

  _gridToWorld(i, j) {
    if (this.glbTerrain) return this.glbTerrain.gridToWorld(i, j)
    const half = this.gridSize / 2
    return new THREE.Vector3(j - half, 0, i - half)
  }

  _getHeight(x, z) {
    return this.glbTerrain ? this.glbTerrain.getHeight(x, z) : 0
  }

  // 安全地表高度采样：采样失败/非有限值时回退 fallbackY，避免 NaN 顶点
  _sampleHeight(x, z, fallbackY = 0) {
    let y = fallbackY
    if (this.glbTerrain?.getHeight) {
      const s = this.glbTerrain.getHeight(x, z)
      if (Number.isFinite(s)) y = s
    }
    return Number.isFinite(y) ? y : (Number.isFinite(fallbackY) ? fallbackY : 0)
  }

  _isInsideTerrain(x, z, margin = 0.12) {
    if (!this.glbTerrain) return true
    return x >= this.glbTerrain._worldMinX + margin &&
      x <= this.glbTerrain._worldMaxX - margin &&
      z >= this.glbTerrain._worldMinZ + margin &&
      z <= this.glbTerrain._worldMaxZ - margin
  }

  _getIntensity() {
    const raw = Number(this.hazard?.peak_scale ?? this.flowIntensity ?? 0.5)
    return THREE.MathUtils.clamp(raw, 0, 1)
  }

  _buildChannelCurve() {
    this._channelPts = this.hazard.channel.map(([i, j]) => {
      const p = this._gridToWorld(i, j)
      const y = this._sampleHeight(p.x, p.z, p.y) + 0.08
      return new THREE.Vector3(p.x, y, p.z)
    })
    this._channelCurve = new THREE.CatmullRomCurve3(
      this._channelPts, false, 'centripetal'
    )
  }

  // 2. 堆积扇：从冲沟末端向河谷/吉隆口岸扇形铺开的泥浆堆积体
  //    视觉上明确展示"泥石流冲下河谷、把口岸地段淤埋"，且随强度增大范围/厚度越明显
  _buildDepositFan() {
    const intensity = this._getIntensity()

    // 扇顶 = 主流带末端地面点
    const endIdx = this._channelPts.length - 1
    const apex = this._channelPts[endIdx].clone()
    const startIdx = Math.max(0, endIdx - 2)
    const dir = new THREE.Vector3()
      .subVectors(apex, this._channelPts[startIdx])
    dir.y = 0
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1)
    dir.normalize()
    const nrm = new THREE.Vector3(-dir.z, 0, dir.x)

    // 只做出口附近的局部泥沙汇聚，不再铺满前景。
    const terrainSize = this.glbTerrain?.targetSize ?? 24
    const fanRadius = Math.min(1.55 + intensity * 0.95, terrainSize * 0.14)
    const spreadDeg = 22 + intensity * 8
    const spread = THREE.MathUtils.degToRad(spreadDeg)
    const rows = 9
    const cols = 17

    const verts = []
    const uvs = []
    const idx = []
    const fanVertexValid = []
    for (let r = 0; r < rows; r++) {
      const rr = r / (rows - 1)
      const along = apex.clone().addScaledVector(dir, r * (rr * fanRadius) * (1 - rr * 0.35))
      const halfW = rr * fanRadius * Math.tan(spread)
      for (let c = 0; c < cols; c++) {
        const ang = -1 + (c / (cols - 1)) * 2        // -1..1
        const p = along.clone().addScaledVector(nrm, ang * halfW)
        const inside = this._isInsideTerrain(p.x, p.z)
        fanVertexValid.push(inside)
        if (!inside) {
          verts.push(0, 0, 0)
          uvs.push(c / (cols - 1), rr)
          continue
        }
        p.y = this._sampleHeight(p.x, p.z, p.y) + 0.08
        verts.push(p.x, p.y, p.z)
        uvs.push((c / (cols - 1)), rr)
      }
    }
    // 只添加顶点有效的三角形，剔除退化/越界三角面
    const validVertex = (index) => {
      const x = verts[index * 3]
      const y = verts[index * 3 + 1]
      const z = verts[index * 3 + 2]
      return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    }
    const addTriangle = (a, b, c) => {
      if (fanVertexValid[a] && fanVertexValid[b] && fanVertexValid[c] &&
          validVertex(a) && validVertex(b) && validVertex(c)) {
        idx.push(a, b, c)
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c
        const b = a + 1
        const d = r * cols + c + cols
        const e = d + 1
        addTriangle(a, d, b)
        addTriangle(b, d, e)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    geo.normalizeNormals()
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
    if (!Number.isFinite(geo.boundingSphere?.radius)) {
      console.warn('泥石流堆积扇几何体无效，跳过构建')
      return null
    }

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x704522,
      roughness: 0.48,
      metalness: 0.0,
      clearcoat: 0.22,
      clearcoatRoughness: 0.38,
      transparent: true,
      opacity: 0.12 + intensity * 0.12,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    })
    this.depositFan = new THREE.Mesh(geo, mat)
    this.depositFan.name = '泥石流堆积扇'
    this.depositFan.position.y = -0.02
    this.depositFan.renderOrder = 3
    this.depositFan.castShadow = false
    this.depositFan.receiveShadow = false
    if (this.mudRibbon) this.mudRibbon.renderOrder = 5
    this.group.add(this.depositFan)
  }

  // 3. 构建连续贴地的流动泥浆曲面带
  _buildMudRibbon() {
    const segments = Math.min(120, Math.max(30, this._channelPts.length * 6))
    const points = this._channelCurve.getSpacedPoints(segments)
    const intensity = this._getIntensity()

    // 视觉显示强度限制：强度影响色/速/粒子，但不再无限扩大几何宽度
    const visualIntensity = THREE.MathUtils.clamp(
      Number(this.displayIntensity ?? this.flowIntensity ?? 0.5),
      0.15,
      1.0
    )
    const widthScale = THREE.MathUtils.lerp(0.72, 1.0, visualIntensity)
    const maxFlowWidth = this.glbTerrain
      ? this.glbTerrain.targetSize * 0.065
      : 1.3
    const baseHalfWidth = Math.min(
      (0.14 + intensity * 0.52) * widthScale,
      maxFlowWidth
    )

    const vertices = []
    const uvs = []
    const indices = []
    const ribbonVertexValid = []

    for (let i = 0; i < points.length; i++) {
      const pt = points[i]
      const t = i / Math.max(1, points.length - 1)
      const tangent = this._channelCurve.getTangentAt(t).normalize()
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x)

      // 源头由细到粗，强度升高时只增加厚度/流速，不让河道横向爆开。
      const sourceTaper = THREE.MathUtils.smoothstep(t, 0.0, 0.18)
      const endTaper = 1.0 - THREE.MathUtils.smoothstep(t, 0.94, 1.0) * 0.35
      const desiredWidth = baseHalfWidth *
        (0.16 + sourceTaper * (0.84 + Math.sin(t * Math.PI) * 0.42)) *
        endTaper
      let w = desiredWidth
      if (this.glbTerrain) {
        const edgeDistance = Math.min(
          pt.x - this.glbTerrain._worldMinX,
          this.glbTerrain._worldMaxX - pt.x,
          pt.z - this.glbTerrain._worldMinZ,
          this.glbTerrain._worldMaxZ - pt.z
        ) - 0.12
        w = Math.min(w, Math.max(0.04, edgeDistance))
      }

      const left = pt.clone().addScaledVector(normal, w)
      const right = pt.clone().addScaledVector(normal, -w)

      // 越界顶点不夹到边界；否则相邻三角形会折叠成模型外的大阴影。
      const leftValid = this._isInsideTerrain(left.x, left.z)
      const rightValid = this._isInsideTerrain(right.x, right.z)
      ribbonVertexValid.push(leftValid, rightValid)
      if (leftValid) {
        left.y = this._sampleHeight(left.x, left.z, pt.y) + 0.08
      } else {
        left.set(0, 0, 0)
      }
      if (rightValid) {
        right.y = this._sampleHeight(right.x, right.z, pt.y) + 0.08
      } else {
        right.set(0, 0, 0)
      }

      vertices.push(left.x, left.y, left.z, right.x, right.y, right.z)
      uvs.push(0, t * 6, 1, t * 6)
    }

    // 只添加顶点有效的三角形，剔除退化/越界三角面
    const validVertex = (index) => {
      const x = vertices[index * 3]
      const y = vertices[index * 3 + 1]
      const z = vertices[index * 3 + 2]
      return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    }
    const addTriangle = (a, b, c) => {
      if (ribbonVertexValid[a] && ribbonVertexValid[b] && ribbonVertexValid[c] &&
          validVertex(a) && validVertex(b) && validVertex(c)) {
        indices.push(a, b, c)
      }
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = i * 2
      const b = a + 1
      const c = a + 2
      const d = a + 3
      addTriangle(a, b, c)
      addTriangle(b, d, c)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    geo.normalizeNormals()
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
    if (!Number.isFinite(geo.boundingSphere?.radius)) {
      console.warn('泥石流主带几何体无效，跳过构建')
      return null
    }

    const mat = new THREE.MeshPhysicalMaterial({
      map: this._flowTexture,
      color: 0x704522,
      roughness: 0.38,
      metalness: 0.0,
      clearcoat: 0.3,
      clearcoatRoughness: 0.3,
      transparent: true,
      opacity: 0.38 + intensity * 0.30,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    })

    this.mudRibbon = new THREE.Mesh(geo, mat)
    this.mudRibbon.name = '泥石流流动主带'
    this.mudRibbon.renderOrder = 4
    this.mudRibbon.castShadow = false
    this.mudRibbon.receiveShadow = false
    this.group.add(this.mudRibbon)
  }

  // 2. 沿冲沟快速喷泻的泥砂粒子流
  _buildCascadeParticles() {
    const intensity = this._getIntensity()
    const count = Math.floor(intensity * 150)

    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    this.particleData = []

    const color1 = new THREE.Color(0xd97706)
    const color2 = new THREE.Color(0x78350f)

    for (let i = 0; i < count; i++) {
      this.particleData.push({
        t: Math.random(),
        speed: 0.15 + Math.random() * 0.25,
        lateralOffset: (Math.random() - 0.5) * 0.4
      })
      const c = Math.random() > 0.4 ? color1 : color2
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const mat = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true
    })

    this.particles = new THREE.Points(geo, mat)
    this.particles.name = '泥石流粒子流'
    this.particles.castShadow = false
    this.particles.receiveShadow = false
    this.group.add(this.particles)
  }

  // 3. 伴随泥流下滚的随机巨石
  _buildRollingBoulders() {
    const count = 10
    const group = new THREE.Group()
    group.name = '泥石流翻滚巨石'
    const geo = new THREE.DodecahedronGeometry(0.12, 0)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3f3f46,
      roughness: 0.95,
      metalness: 0.0
    })

    this.boulders = []
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.scale.setScalar(0.7 + Math.random() * 0.8)
      group.add(mesh)
      this.boulders.push({
        mesh,
        t: (i / count),
        speed: 0.08 + Math.random() * 0.12,
        lateral: (Math.random() - 0.5) * 0.35,
        rotSpeed: 2 + Math.random() * 4
      })
    }
    this.group.add(group)
    group.traverse(obj => {
      obj.castShadow = false
      obj.receiveShadow = false
    })
  }

  _recordBaseOpacities() {
    this._baseOpacities.clear()
    const items = [this.mudRibbon, this.particles, this.depositFan]
    for (const obj of items) {
      if (obj && obj.material && 'opacity' in obj.material) {
        this._baseOpacities.set(obj, obj.material.opacity)
      }
    }
  }

  setDisplayIntensity(value) {
    this.displayIntensity = THREE.MathUtils.clamp(value, 0, 1)
    for (const [obj, base] of this._baseOpacities) {
      if (obj && obj.material && 'opacity' in obj.material) {
        obj.material.opacity = base * this.displayIntensity
      }
    }
  }

  setFlowIntensity(value) {
    this.flowIntensity = THREE.MathUtils.clamp(value, 0, 1)
  }

  setSlopeFactor(f) {
    this.slopeFactor = f
  }

  // 每帧动画更新
  update(delta, globalTime) {
    this.time = globalTime
    const intensity = this._getIntensity()
    const currentSpeed = 0.8 + intensity * 2.2

    // 1. 泥浆贴图向下滚动 —— 形成可视化的"流动"
    if (this._flowTexture) {
      this._flowTexture.offset.y -= delta * currentSpeed * 0.4
    }

    // 1b. 堆积扇随强度淡入淡出 + 轻微呼吸，越强越"厚重蔓延"
    if (this.depositFan && this.depositFan.material) {
      const base = this._baseOpacities.get(this.depositFan) ?? 0.5
      const pulse = 1 + Math.sin(globalTime * 0.9) * 0.05
      this.depositFan.material.opacity =
        base * (this.displayIntensity) * THREE.MathUtils.clamp(intensity, 0, 1.2) * pulse
    }

    if (!this._channelCurve) return

    // 2. 泥砂粒子下泻更新
    if (this.particles) {
      const posArr = this.particles.geometry.attributes.position.array
      for (let i = 0; i < this.particleData.length; i++) {
        const p = this.particleData[i]
        p.t += delta * p.speed * currentSpeed
        if (p.t > 1) p.t -= 1

        const pt = this._channelCurve.getPointAt(p.t)
        const tangent = this._channelCurve.getTangentAt(p.t).normalize()
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x)

        const finalPos = pt.clone().addScaledVector(normal, p.lateralOffset)
        if (this.glbTerrain) {
          finalPos.y = this.glbTerrain.getHeight(finalPos.x, finalPos.z) + 0.1
        }

        posArr[i * 3] = finalPos.x
        posArr[i * 3 + 1] = finalPos.y
        posArr[i * 3 + 2] = finalPos.z
      }
      this.particles.geometry.attributes.position.needsUpdate = true
    }

    // 3. 巨石沿流向翻滚更新
    if (this.boulders) {
      this.boulders.forEach(b => {
        b.t += delta * b.speed * currentSpeed
        if (b.t > 1) b.t -= 1

        const pt = this._channelCurve.getPointAt(b.t)
        const tangent = this._channelCurve.getTangentAt(b.t).normalize()
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x)

        const finalPos = pt.clone().addScaledVector(normal, b.lateral)
        if (this.glbTerrain) {
          finalPos.y = this.glbTerrain.getHeight(finalPos.x, finalPos.z) + 0.08
        }

        b.mesh.position.copy(finalPos)
        b.mesh.rotation.x += delta * b.rotSpeed
        b.mesh.rotation.z += delta * b.rotSpeed
      })
    }
  }

  addToScene(scene) { scene.add(this.group) }
  removeFromScene(scene) { scene.remove(this.group) }
}
