import * as THREE from 'three'

// 静态路径节点抽稀步长：完整路径仍用于 AI/动画，静态圆环每隔 STRIKE 点取 1 个
const PATH_DISPLAY_STRIDE = 2

export class Terrain {
  constructor(gridSize = 24, options = {}) {
    this.gridSize = gridSize
    this.cellSize = 1.8
    this.subdivision = 10  // 提高细分度，让地形曲面更顺滑（接近高德3D地图观感）
    this.mesh = null
    this.highlightCells = []
    this.grassPatches = []
    this.treeGroups = []
    this.rockGroups = []
    this.debrisFlowZones = []  // 泥石流危险区可视化
    // 当使用 GLB 作为基础地形时，跳过程序化主网格，只保留辅助元素
    this.useGLBBase = options.useGLBBase ?? false
    // 外部传入的 GLB 地形引用，用于从模型表面采样高度
    this.glbTerrain = options.glbTerrain ?? null
    // 世界空间尺寸：GLB 模式用 targetSize，否则用 gridSize*cellSize
    this.worldSize = this.glbTerrain?.targetSize ?? this.gridSize * this.cellSize
  }

  // ===== 统一坐标接口：所有路径/标记/泥石流都从这里取世界坐标 =====
  _gridToWorld(i, j) {
    if (this.glbTerrain) {
      const p = this.glbTerrain.gridToWorld(i, j)
      return { x: p.x, z: p.z }
    }
    const step = this.worldSize / (this.gridSize - 1)
    const half = this.worldSize / 2
    return {
      x: j * step - half,
      z: i * step - half
    }
  }

  _getWorldSurfacePosition(i, j, terrainData) {
    const p = this._gridToWorld(i, j)
    const y = this.glbTerrain
      ? this.glbTerrain.getHeight(p.x, p.z)
      : this._sampleHeight(i, j, terrainData) * 0.5
    return { x: p.x, y, z: p.z }
  }

  // ===== 吉隆口岸式垂直自然带颜色分带 =====
  // 低海拔河谷湿泥 → 泥石流堆积扇碎石 → 针叶林 → 高山灌丛草甸 → 裸岩 → 雪线
  _getHeightColor(height, maxHeight = 10) {
    const t = Math.max(0, Math.min(1, height / maxHeight))

    if (t < 0.22) {
      // 河谷底部：溪流+湿泥浆（深褐绿）
      const f = t / 0.22
      return new THREE.Color(0.26 + f * 0.06, 0.35 + f * 0.05, 0.22 + f * 0.02)
    } else if (t < 0.4) {
      // 泥石流堆积扇：灰黄色碎石泥地
      const f = (t - 0.22) / 0.18
      return new THREE.Color(0.58 - f * 0.08, 0.52 - f * 0.04, 0.42 - f * 0.06)
    } else if (t < 0.6) {
      // 针叶林带：深绿喜马拉雅云杉
      const f = (t - 0.4) / 0.2
      return new THREE.Color(0.18 + f * 0.32, 0.48 - f * 0.08, 0.21 + f * 0.11)
    } else if (t < 0.78) {
      // 高海拔灌丛草甸：黄绿色
      const f = (t - 0.6) / 0.18
      return new THREE.Color(0.50 - f * 0.05, 0.56 - f * 0.11, 0.32 + f * 0.13)
    } else if (t < 0.92) {
      // 裸岩峭壁：深灰
      const f = (t - 0.78) / 0.14
      return new THREE.Color(0.45 - f * 0.05, 0.45 - f * 0.05, 0.47 - f * 0.02)
    } else {
      // 山顶积雪：白色（对应吉隆附近海拔4000+高山）
      const f = (t - 0.92) / 0.08
      return new THREE.Color(0.92 + f * 0.08, 0.94 + f * 0.06, 0.98)
    }
  }

  _getHeight(i, j, terrainData) {
    return terrainData[i][j] * 0.5
  }

  _smoothHeight(i, j, terrainData) {
    const gs = this.gridSize
    let sum = 0
    let count = 0
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const ni = Math.max(0, Math.min(gs - 1, i + di))
        const nj = Math.max(0, Math.min(gs - 1, j + dj))
        sum += terrainData[ni][nj]
        count++
      }
    }
    return (sum / count) * 0.5
  }

  _sampleHeight(fi, fj, terrainData) {
    const gs = this.gridSize
    const i0 = Math.floor(fi)
    const j0 = Math.floor(fj)
    const i1 = Math.min(gs - 1, i0 + 1)
    const j1 = Math.min(gs - 1, j0 + 1)
    const ti = fi - i0
    const tj = fj - j0

    const h00 = terrainData[i0][j0]
    const h10 = terrainData[i1][j0]
    const h01 = terrainData[i0][j1]
    const h11 = terrainData[i1][j1]

    return h00 * (1 - ti) * (1 - tj) +
           h10 * ti * (1 - tj) +
           h01 * (1 - ti) * tj +
           h11 * ti * tj
  }

  // 从 GLB 表面或程序化数据获取高度（优先用 GLB）
  // 只返回高度，XZ 坐标由 _gridToWorld 统一计算
  _getSurfaceY(fi, fj, terrainData) {
    if (this.glbTerrain) {
      const p = this._gridToWorld(fi, fj)
      return this.glbTerrain.getHeight(p.x, p.z)
    }
    return this._sampleHeight(fi, fj, terrainData) * 0.5
  }

  build(terrainData, start = null, goal = null) {
    this._start = start || [0, this.gridSize - 1]
    this._goal = goal || [this.gridSize - 1, 0]
    if (this.mesh) {
      this.mesh.traverse((child) => {
        if (child.geometry) child.geometry.dispose()
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose())
          } else {
            child.material.dispose()
          }
        }
      })
      this.mesh.parent?.remove(this.mesh)
    }
    this.grassPatches = []
    this.treeGroups = []
    this.rockGroups = []

    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2

    const group = new THREE.Group()

    // ===== 当使用 GLB 作为基础地形时，跳过程序化主网格和底座平台 =====
    if (!this.useGLBBase) {
      const sub = this.subdivision
      const totalVerts = (gs - 1) * sub + 1

      const vertices = []
      const colors = []
      const indices = []

      for (let vi = 0; vi < totalVerts; vi++) {
        for (let vj = 0; vj < totalVerts; vj++) {
          const fi = vi / sub
          const fj = vj / sub
          const i0 = Math.floor(fi)
          const j0 = Math.floor(fj)
          const i1 = Math.min(gs - 1, i0 + 1)
          const j1 = Math.min(gs - 1, j0 + 1)
          const ti = fi - i0
          const tj = fj - j0

          const h00 = terrainData[i0][j0]
          const h10 = terrainData[i1][j0]
          const h01 = terrainData[i0][j1]
          const h11 = terrainData[i1][j1]

          let h = h00 * (1 - ti) * (1 - tj) +
                  h10 * ti * (1 - tj) +
                  h01 * (1 - ti) * tj +
                  h11 * ti * tj

          const detailNoise = this._detailNoise(fi * 3, fj * 3) * 0.15
          h += detailNoise

          const x = fj * cs - half + cs / 2
          const z = fi * cs - half + cs / 2
          const y = h * 0.5

          vertices.push(x, y, z)

          const color = this._getHeightColor(h, 10)
          const noise = (Math.random() - 0.5) * 0.04
          colors.push(
            Math.max(0, Math.min(1, color.r + noise)),
            Math.max(0, Math.min(1, color.g + noise)),
            Math.max(0, Math.min(1, color.b + noise))
          )
        }
      }

      for (let vi = 0; vi < totalVerts - 1; vi++) {
        for (let vj = 0; vj < totalVerts - 1; vj++) {
          const a = vi * totalVerts + vj
          const b = vi * totalVerts + (vj + 1)
          const c = (vi + 1) * totalVerts + vj
          const d = (vi + 1) * totalVerts + (vj + 1)
          indices.push(a, c, b)
          indices.push(b, c, d)
        }
      }

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      geometry.setIndex(indices)
      geometry.computeVertexNormals()

      const noiseCanvas = document.createElement('canvas')
      noiseCanvas.width = 256
      noiseCanvas.height = 256
      const nctx = noiseCanvas.getContext('2d')
      const imgData = nctx.createImageData(256, 256)
      for (let i = 0; i < imgData.data.length; i += 4) {
        const n = Math.random() * 30
        imgData.data[i] = 128 + n
        imgData.data[i + 1] = 128 + n
        imgData.data[i + 2] = 128 + n
        imgData.data[i + 3] = 255
      }
      nctx.putImageData(imgData, 0, 0)
      const noiseTex = new THREE.CanvasTexture(noiseCanvas)
      noiseTex.wrapS = THREE.RepeatWrapping
      noiseTex.wrapT = THREE.RepeatWrapping
      noiseTex.repeat.set(8, 8)

      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: false,
        roughness: 0.92,
        metalness: 0.02,
        side: THREE.DoubleSide,
        map: noiseTex
      })

      const terrainMesh = new THREE.Mesh(geometry, material)
      terrainMesh.castShadow = true
      terrainMesh.receiveShadow = true
      group.add(terrainMesh)

      this._addBasePlatform(group, terrainData)
    }

    // 使用 GLB 时只保留路径和标记，关闭容易弄脏画面的辅助覆盖层
    if (!this.useGLBBase) {
      this._addGrass(group, terrainData)
      this._addTrees(group, terrainData)
      this._addRocks(group, terrainData)
      this._addMushrooms(group, terrainData)
      this._addFlowers(group, terrainData)
      // 泥石流显示已交由 DebrisFlow 统一负责，避免在地形上再叠一层泥浆平面造成穿插
      // this._addDebrisFlowZones(group, terrainData)
    }
    // 等高线层暂不叠加，避免半透明平面覆盖 GLB 表面
    // if (this.useGLBBase && this.glbTerrain) {
    //   this._addContourLayer(group)
    // }
    this._addMarkers(group, terrainData)
    this.mesh = group

    return this.mesh
  }

  // ===== 等高线/高度带可视化层（GLB 地形专用） =====
  // 在 GLB 表面上方叠加半透明颜色层，用颜色表示高度带和等高线
  _addContourLayer(group) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2
    const segments = 120  // 细分度，等高线更细腻

    const geometry = new THREE.PlaneGeometry(gs * cs, gs * cs, segments, segments)
    geometry.rotateX(-Math.PI / 2)

    const positions = geometry.attributes.position
    const colors = new Float32Array(positions.count * 3)

    // 高度带颜色（从谷底到雪线）
    const colorBands = [
      { height: 0.0, color: new THREE.Color(0x4a5d3a) },      // 谷底湿地
      { height: 0.5, color: new THREE.Color(0x5a7a42) },      // 低海拔植被
      { height: 1.2, color: new THREE.Color(0x6b8c4e) },      // 中海拔森林
      { height: 2.2, color: new THREE.Color(0x7a8a5a) },      // 高海拔灌丛
      { height: 3.2, color: new THREE.Color(0x7a7268) },      // 裸岩
      { height: 4.2, color: new THREE.Color(0x9a9690) },      // 高山裸岩
      { height: 5.5, color: new THREE.Color(0xd8dce0) },      // 雪线
    ]

    // 获取所有顶点高度，找出最大高度
    const heights = []
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i)
      const z = positions.getZ(i)
      const fi = (z + half - cs / 2) / cs
      const fj = (x + half - cs / 2) / cs
      const h = this.glbTerrain.getSurfaceHeight(fi, fj)
      heights.push(h)
    }

    for (let i = 0; i < positions.count; i++) {
      const h = heights[i]
      const y = h + 0.015  // 略高于表面，避免 z-fighting
      positions.setY(i, y)

      // 根据高度带插值颜色
      let color = colorBands[colorBands.length - 1].color.clone()
      for (let b = 0; b < colorBands.length - 1; b++) {
        if (h <= colorBands[b + 1].height) {
          const t = (h - colorBands[b].height) / (colorBands[b + 1].height - colorBands[b].height)
          color = colorBands[b].color.clone().lerp(colorBands[b + 1].color, Math.max(0, Math.min(1, t)))
          break
        }
      }

      // 等高线效果：在特定高度处颜色变亮
      const contourInterval = 0.5  // 每 0.5 单位一条等高线
      const contourPos = (h % contourInterval) / contourInterval
      const contourDist = Math.min(contourPos, 1 - contourPos)
      if (contourDist < 0.04) {
        const intensity = 1 - contourDist / 0.04
        color.lerp(new THREE.Color(0xf5e6c8), intensity * 0.5)
      }

      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }

    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geometry.computeVertexNormals()

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.35,  // 半透明，让 GLB 纹理仍可见
      roughness: 0.9,
      metalness: 0.0,
      depthWrite: false
    })

    const contourMesh = new THREE.Mesh(geometry, material)
    contourMesh.receiveShadow = true
    contourMesh.userData.isContourLayer = true
    group.add(contourMesh)
  }

  // ===== 新增：泥石流冲沟与危险区可视化 =====
  // 在低海拔堆积扇区域覆盖半透明泥浆层，显示 2026年8月泥石流实际影响范围
  _addDebrisFlowZones(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2

    // 1. 泥石流泥浆覆盖层：半透明流动质感
    const mudPlaneGeo = new THREE.PlaneGeometry(gs * cs * 0.6, gs * cs * 0.4, 24, 16)
    const mudMat = new THREE.MeshStandardMaterial({
      color: 0x785a44,
      transparent: true,
      opacity: 0.55,
      roughness: 0.98,
      metalness: 0.01
    })

    // 把泥浆层放到低海拔堆积扇区域（地形西南角，靠近冲沟出口）
    const mudOffsetX = -gs * cs * 0.15
    const mudOffsetZ = -gs * cs * 0.2
    const mudPlane = new THREE.Mesh(mudPlaneGeo, mudMat)
    mudPlane.rotation.x = -Math.PI / 2
    mudPlane.position.set(mudOffsetX, 0.15, mudOffsetZ)
    // 当使用 GLB 地形时，泥浆层贴到 GLB 表面
    if (this.glbTerrain) {
      const surfaceY = this.glbTerrain.getSurfaceHeight(
        (mudOffsetZ + half - cs / 2) / cs,
        (mudOffsetX + half - cs / 2) / cs
      )
      mudPlane.position.y = surfaceY + 0.025
    }
    mudPlane.receiveShadow = true
    mudPlane.userData.isDebrisMud = true
    group.add(mudPlane)
    this.debrisFlowZones.push(mudPlane)

    // 2. 散落碎石块：泥石流冲下的巨石
    const boulderGeo = new THREE.DodecahedronGeometry(0.18, 0)
    const boulderMat = new THREE.MeshStandardMaterial({
      color: 0x5a4a3a,
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true
    })

    for (let k = 0; k < 18; k++) {
      const fi = 0.1 + Math.random() * (gs * 0.4)
      const fj = 0.1 + Math.random() * (gs * 0.4)
      const h = this._sampleHeight(fi, fj, terrainData)
      const heightRatio = h / 10
      // 碎石只在低海拔堆积扇
      if (heightRatio > 0.42) continue

      const x = fj * cs - half + cs / 2
      const z = fi * cs - half + cs / 2
      const y = h * 0.5

      const scale = 0.3 + Math.random() * 1.2
      const boulder = new THREE.Mesh(boulderGeo, boulderMat)
      boulder.position.set(x, y + 0.08 * scale, z)
      boulder.scale.set(
        scale * (0.8 + Math.random() * 0.4),
        scale * (0.6 + Math.random() * 0.4),
        scale * (0.8 + Math.random() * 0.4)
      )
      boulder.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      )
      boulder.castShadow = true
      boulder.receiveShadow = true
      boulder.userData.isDebrisBoulder = true
      group.add(boulder)
      this.debrisFlowZones.push(boulder)
    }

    // 3. 警示标记柱：标识泥石流危险区边界
    const warningGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.8, 8)
    const warningMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.85
    })
    const warningCapGeo = new THREE.SphereGeometry(0.08, 8, 6)
    const warningCapMat = new THREE.MeshStandardMaterial({
      color: 0xf87171,
      emissive: 0xef4444,
      emissiveIntensity: 0.6
    })

    for (let k = 0; k < 5; k++) {
      const angle = (k / 5) * Math.PI * 1.4 + 0.3
      const r = gs * cs * 0.18
      const x = mudOffsetX + Math.cos(angle) * r
      const z = mudOffsetZ + Math.sin(angle) * r
      const fi = (z + half - cs / 2) / cs
      const fj = (x + half - cs / 2) / cs
      const h = this._sampleHeight(Math.max(0, Math.min(gs - 1, fi)),
                                    Math.max(0, Math.min(gs - 1, fj)), terrainData)

      const pole = new THREE.Mesh(warningGeo, warningMat)
      pole.position.set(x, h * 0.5 + 0.4, z)
      pole.castShadow = true
      pole.userData.isDebrisWarning = true
      group.add(pole)
      this.debrisFlowZones.push(pole)

      const cap = new THREE.Mesh(warningCapGeo, warningCapMat)
      cap.position.set(x, h * 0.5 + 0.85, z)
      group.add(cap)
      this.debrisFlowZones.push(cap)
    }
  }

  _detailNoise(x, y) {
    const sin1 = Math.sin(x * 1.7 + y * 2.3)
    const sin2 = Math.sin(x * 4.2 - y * 3.1 + 1.5)
    const sin3 = Math.sin(x * 7.8 + y * 5.5 + 2.8)
    return (sin1 * 0.5 + sin2 * 0.3 + sin3 * 0.2)
  }

  _addGrass(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2
    const grassCount = 200

    const grassGeo = new THREE.PlaneGeometry(0.1, 0.32, 1, 3)
    const grassPositions = grassGeo.attributes.position.array
    for (let i = 0; i < grassPositions.length; i += 3) {
      const yRatio = grassPositions[i + 1] / 0.16 + 0.5
      grassPositions[i] += (Math.random() - 0.5) * 0.02 * yRatio
    }
    grassGeo.attributes.position.needsUpdate = true

    const grassMat = new THREE.MeshStandardMaterial({
      color: 0x4ade80,
      side: THREE.DoubleSide,
      roughness: 0.85,
      transparent: true,
      opacity: 0.92
    })

    for (let k = 0; k < grassCount; k++) {
      const fi = Math.random() * (gs - 1)
      const fj = Math.random() * (gs - 1)
      const h = this._getSurfaceY(fi, fj, terrainData)
      const heightRatio = h / 5
      if (heightRatio > 0.55) continue

      const x = fj * cs - half + cs / 2
      const z = fi * cs - half + cs / 2
      const y = h

      const scaleVar = 0.6 + Math.random() * 0.8
      const grass = new THREE.Mesh(grassGeo, grassMat)
      grass.position.set(x, y + 0.16 * scaleVar, z)
      grass.rotation.y = Math.random() * Math.PI
      grass.scale.setScalar(scaleVar)
      grass.userData.grassIndex = k
      grass.userData.baseX = x
      grass.userData.baseZ = z
      grass.userData.baseRotation = grass.rotation.y
      group.add(grass)
      this.grassPatches.push(grass)
    }
  }

  _addTrees(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2
    const treeCount = 12

    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x78350f,
      roughness: 0.9,
      metalness: 0.05
    })

    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x16a34a,
      roughness: 0.8,
      metalness: 0.05
    })

    const leafMat2 = new THREE.MeshStandardMaterial({
      color: 0x15803d,
      roughness: 0.85,
      metalness: 0.03
    })

    for (let k = 0; k < treeCount; k++) {
      const fi = 0.5 + Math.random() * (gs - 1.5)
      const fj = 0.5 + Math.random() * (gs - 1.5)
      const h = this._getSurfaceY(fi, fj, terrainData)
      const heightRatio = h / 5
      if (heightRatio < 0.15 || heightRatio > 0.5) continue

      const x = fj * cs - half + cs / 2
      const z = fi * cs - half + cs / 2
      const y = h

      const treeGroup = new THREE.Group()
      treeGroup.position.set(x, y, z)

      const scale = 0.5 + Math.random() * 0.8

      const trunkHeight = 0.6 * scale
      const trunkGeo = new THREE.CylinderGeometry(0.04 * scale, 0.06 * scale, trunkHeight, 8)
      const trunk = new THREE.Mesh(trunkGeo, trunkMat)
      trunk.position.y = trunkHeight / 2
      trunk.castShadow = true
      trunk.receiveShadow = true
      treeGroup.add(trunk)

      const leafLayers = 3
      for (let i = 0; i < leafLayers; i++) {
        const layerScale = 1 - i * 0.25
        const leafGeo = new THREE.ConeGeometry(0.28 * scale * layerScale, 0.35 * scale, 8)
        const mat = i % 2 === 0 ? leafMat : leafMat2
        const leaf = new THREE.Mesh(leafGeo, mat)
        leaf.position.y = trunkHeight + 0.1 * scale + i * 0.22 * scale
        leaf.castShadow = true
        leaf.receiveShadow = true
        treeGroup.add(leaf)
      }

      treeGroup.rotation.y = Math.random() * Math.PI
      treeGroup.userData.treeIndex = k
      treeGroup.userData.swayOffset = Math.random() * Math.PI * 2
      group.add(treeGroup)
      this.treeGroups.push(treeGroup)
    }
  }

  _addRocks(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2
    const rockCount = 25

    const rockGeo = new THREE.DodecahedronGeometry(0.12, 0)
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.95,
      metalness: 0.08,
      flatShading: true
    })

    const rockMat2 = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.92,
      metalness: 0.1,
      flatShading: true
    })

    for (let k = 0; k < rockCount; k++) {
      const fi = Math.random() * (gs - 1)
      const fj = Math.random() * (gs - 1)
      const h = this._getSurfaceY(fi, fj, terrainData)
      const heightRatio = h / 5
      if (heightRatio < 0.35) continue

      const x = fj * cs - half + cs / 2
      const z = fi * cs - half + cs / 2
      const y = h

      const scale = 0.4 + Math.random() * 1.8
      const mat = Math.random() > 0.5 ? rockMat : rockMat2
      const rock = new THREE.Mesh(rockGeo, mat)
      rock.position.set(x, y + 0.08 * scale, z)
      rock.scale.set(
        scale * (0.8 + Math.random() * 0.4),
        scale * (0.6 + Math.random() * 0.4),
        scale * (0.8 + Math.random() * 0.4)
      )
      rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
      rock.castShadow = true
      rock.receiveShadow = true
      rock.userData.rockIndex = k
      group.add(rock)
      this.rockGroups.push(rock)
    }
  }

  _addMushrooms(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2
    const mushroomCount = 8

    const stemMat = new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      roughness: 0.7,
      metalness: 0.05
    })

    const capMats = [
      new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.6, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.6, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ color: 0xa855f7, roughness: 0.6, metalness: 0.05 }),
    ]

    for (let k = 0; k < mushroomCount; k++) {
      const fi = Math.random() * (gs - 1)
      const fj = Math.random() * (gs - 1)
      const h = this._getSurfaceY(fi, fj, terrainData)
      const heightRatio = h / 5
      if (heightRatio > 0.45) continue

      const x = fj * cs - half + cs / 2
      const z = fi * cs - half + cs / 2
      const y = h

      const mushroomGroup = new THREE.Group()
      mushroomGroup.position.set(x, y, z)

      const scale = 0.25 + Math.random() * 0.3

      const stemGeo = new THREE.CylinderGeometry(0.03 * scale, 0.04 * scale, 0.12 * scale, 8)
      const stem = new THREE.Mesh(stemGeo, stemMat)
      stem.position.y = 0.06 * scale
      mushroomGroup.add(stem)

      const capGeo = new THREE.SphereGeometry(0.08 * scale, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)
      const capMat = capMats[Math.floor(Math.random() * capMats.length)]
      const cap = new THREE.Mesh(capGeo, capMat)
      cap.position.y = 0.12 * scale
      mushroomGroup.add(cap)

      const dotGeo = new THREE.SphereGeometry(0.015 * scale, 6, 6)
      const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
      for (let d = 0; d < 3; d++) {
        const dot = new THREE.Mesh(dotGeo, dotMat)
        const angle = (d / 3) * Math.PI * 2 + Math.random()
        const dist = 0.04 * scale
        dot.position.set(
          Math.cos(angle) * dist,
          0.14 * scale,
          Math.sin(angle) * dist
        )
        mushroomGroup.add(dot)
      }

      mushroomGroup.rotation.y = Math.random() * Math.PI
      group.add(mushroomGroup)
    }
  }

  _addFlowers(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2
    const flowerCount = 15

    const flowerColors = [
      0xf472b6, 0xfbbf24, 0x60a5fa, 0xa78bfa, 0xf87171
    ]

    for (let k = 0; k < flowerCount; k++) {
      const fi = Math.random() * (gs - 1)
      const fj = Math.random() * (gs - 1)
      const h = this._getSurfaceY(fi, fj, terrainData)
      const heightRatio = h / 5
      if (heightRatio > 0.4) continue

      const x = fj * cs - half + cs / 2
      const z = fi * cs - half + cs / 2
      const y = h

      const flowerGroup = new THREE.Group()
      flowerGroup.position.set(x, y, z)

      const stemGeo = new THREE.CylinderGeometry(0.005, 0.006, 0.1, 4)
      const stemMat = new THREE.MeshStandardMaterial({ color: 0x22c55e })
      const stem = new THREE.Mesh(stemGeo, stemMat)
      stem.position.y = 0.05
      flowerGroup.add(stem)

      const petalColor = flowerColors[Math.floor(Math.random() * flowerColors.length)]
      const petalMat = new THREE.MeshStandardMaterial({
        color: petalColor,
        roughness: 0.6,
        metalness: 0.05
      })

      const petalCount = 5
      for (let p = 0; p < petalCount; p++) {
        const petalGeo = new THREE.SphereGeometry(0.02, 8, 6)
        const petal = new THREE.Mesh(petalGeo, petalMat)
        const angle = (p / petalCount) * Math.PI * 2
        petal.position.set(
          Math.cos(angle) * 0.025,
          0.1,
          Math.sin(angle) * 0.025
        )
        petal.scale.set(1, 0.5, 0.6)
        flowerGroup.add(petal)
      }

      const centerGeo = new THREE.SphereGeometry(0.012, 8, 6)
      const centerMat = new THREE.MeshStandardMaterial({ color: 0xfcd34d })
      const center = new THREE.Mesh(centerGeo, centerMat)
      center.position.y = 0.1
      flowerGroup.add(center)

      flowerGroup.rotation.y = Math.random() * Math.PI
      group.add(flowerGroup)
    }
  }

  _addSnowCaps(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2
    const sub = this.subdivision
    const totalVerts = (gs - 1) * sub + 1

    const snowVertices = []
    const snowColors = []
    const snowIndices = []
    let idx = 0

    for (let vi = 0; vi < totalVerts; vi++) {
      for (let vj = 0; vj < totalVerts; vj++) {
        const fi = vi / sub
        const fj = vj / sub
        const h = this._sampleHeight(fi, fj, terrainData)
        const heightRatio = h / 10

        const x = fj * cs - half + cs / 2
        const z = fi * cs - half + cs / 2
        const y = h * 0.5

        if (heightRatio > 0.75) {
          const snowAmount = Math.min(1, (heightRatio - 0.75) / 0.25)
          const snowY = y + 0.05 * snowAmount
          
          snowVertices.push(x, snowY, z)
          snowColors.push(1, 1, 1)
          
          if (vi < totalVerts - 1 && vj < totalVerts - 1) {
            const nextH = this._sampleHeight((vi + 1) / sub, (vj + 1) / sub, terrainData)
            if (nextH / 10 > 0.75) {
              const a = idx
              const b = idx + 1
              const c = idx + totalVerts
              const d = idx + totalVerts + 1
              snowIndices.push(a, c, b)
              snowIndices.push(b, c, d)
            }
          }
          idx++
        }
      }
    }

    if (snowVertices.length > 0) {
      const snowGeo = new THREE.BufferGeometry()
      snowGeo.setAttribute('position', new THREE.Float32BufferAttribute(snowVertices, 3))
      snowGeo.setAttribute('color', new THREE.Float32BufferAttribute(snowColors, 3))
      snowGeo.setIndex(snowIndices)
      snowGeo.computeVertexNormals()

      const snowMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.4,
        metalness: 0.02,
        transparent: true,
        opacity: 0.9
      })

      const snow = new THREE.Mesh(snowGeo, snowMat)
      snow.receiveShadow = true
      group.add(snow)
    }
  }

  _addBasePlatform(group, terrainData) {
    const gs = this.gridSize
    const cs = this.cellSize
    const half = (gs * cs) / 2

    const baseHeight = 2.2
    const baseShape = new THREE.Shape()
    const segments = 80
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const radius = half + 1.2 + Math.sin(angle * 3) * 0.18 + Math.sin(angle * 5 + 0.5) * 0.1
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius
      if (i === 0) {
        baseShape.moveTo(x, z)
      } else {
        baseShape.lineTo(x, z)
      }
    }

    const extrudeSettings = {
      depth: baseHeight,
      bevelEnabled: true,
      bevelThickness: 0.25,
      bevelSize: 0.18,
      bevelSegments: 5,
      curveSegments: 5
    }

    const baseGeo = new THREE.ExtrudeGeometry(baseShape, extrudeSettings)
    baseGeo.rotateX(-Math.PI / 2)
    baseGeo.translate(0, -baseHeight - 0.5, 0)

    const positions = baseGeo.attributes.position
    const colors = []
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i)
      const t = Math.max(0, Math.min(1, (y + baseHeight + 0.5) / baseHeight))
      const r = 0.04 + t * 0.08
      const g = 0.06 + t * 0.12
      const b = 0.10 + t * 0.14
      colors.push(r, g, b)
    }
    baseGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    baseGeo.computeVertexNormals()

    const baseMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.05,
      flatShading: false
    })
    const base = new THREE.Mesh(baseGeo, baseMat)
    base.receiveShadow = true
    base.castShadow = true
    group.add(base)

    const ringGeo = new THREE.TorusGeometry(half + 1.3, 0.04, 10, 80)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.45
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.position.set(0, -0.22, 0)
    ring.rotation.x = Math.PI / 2
    ring.userData.isRing = true
    group.add(ring)

    const ring2Geo = new THREE.TorusGeometry(half + 1.8, 0.025, 8, 80)
    const ring2Mat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.25
    })
    const ring2 = new THREE.Mesh(ring2Geo, ring2Mat)
    ring2.position.set(0, -0.6, 0)
    ring2.rotation.x = Math.PI / 2
    group.add(ring2)

    const rockCount = 25
    const rockGeo = new THREE.DodecahedronGeometry(0.18, 0)
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.92,
      metalness: 0.08,
      flatShading: true
    })

    for (let i = 0; i < rockCount; i++) {
      const angle = (i / rockCount) * Math.PI * 2 + Math.random() * 0.3
      const radius = half + 0.4 + Math.random() * 0.9
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius
      const y = -0.55 - Math.random() * 0.7
      const rock = new THREE.Mesh(rockGeo, rockMat)
      rock.position.set(x, y, z)
      rock.scale.set(
        0.5 + Math.random() * 0.9,
        0.4 + Math.random() * 0.8,
        0.5 + Math.random() * 0.9
      )
      rock.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      )
      rock.castShadow = true
      rock.receiveShadow = true
      group.add(rock)
    }
  }

  _addMarkers(group, terrainData) {
    const gs = this.gridSize
    const [si, sj] = this._start
    const [gi, gj] = this._goal

    // 使用 glbTerrain 的统一坐标系（targetSize），确保和路径、泥石流对齐
    let startX, startZ, goalX, goalZ
    if (this.glbTerrain) {
      const sp = this.glbTerrain.gridToWorld(si, sj)
      const gp = this.glbTerrain.gridToWorld(gi, gj)
      startX = sp.x; startZ = sp.z
      goalX = gp.x; goalZ = gp.z
    } else {
      const cs = this.cellSize
      const half = (gs * cs) / 2
      startX = sj * cs - half + cs / 2
      startZ = si * cs - half + cs / 2
      goalX = gj * cs - half + cs / 2
      goalZ = gi * cs - half + cs / 2
    }

    const startY = this._getSurfaceY(si, sj, terrainData)
    const goalY = this._getSurfaceY(gi, gj, terrainData)

    const startGroup = this._createFlag(0x22c55e, 0x4ade80)
    startGroup.position.set(startX, startY, startZ)
    startGroup.userData.type = 'start'
    group.add(startGroup)
    this.startMarker = startGroup

    const goalGroup = this._createFlag(0xef4444, 0xf87171)
    goalGroup.position.set(goalX, goalY, goalZ)
    goalGroup.userData.type = 'goal'
    group.add(goalGroup)
    this.goalMarker = goalGroup
  }

  _createFlag(poleColor, flagColor) {
    const group = new THREE.Group()

    const poleGeo = new THREE.CylinderGeometry(0.04, 0.05, 1.8, 10)
    const poleMat = new THREE.MeshStandardMaterial({
      color: poleColor,
      roughness: 0.55,
      metalness: 0.45
    })
    const pole = new THREE.Mesh(poleGeo, poleMat)
    pole.position.set(0, 0.9, 0)
    pole.castShadow = true
    group.add(pole)

    const flagGroup = new THREE.Group()
    const flagGeo = new THREE.PlaneGeometry(0.75, 0.5, 8, 4)
    const flagMat = new THREE.MeshStandardMaterial({
      color: flagColor,
      emissive: flagColor,
      emissiveIntensity: 0.2,
      side: THREE.DoubleSide,
      roughness: 0.65,
      metalness: 0.08
    })
    const flag = new THREE.Mesh(flagGeo, flagMat)
    flag.position.set(0.38, 1.45, 0)
    flag.castShadow = true
    flagGroup.add(flag)
    flagGroup.userData.flag = flag
    group.add(flagGroup)

    const baseGeo = new THREE.CylinderGeometry(0.25, 0.32, 0.12, 14)
    const baseMat = new THREE.MeshStandardMaterial({
      color: poleColor,
      roughness: 0.65,
      metalness: 0.25
    })
    const base = new THREE.Mesh(baseGeo, baseMat)
    base.position.set(0, 0.06, 0)
    base.castShadow = true
    base.receiveShadow = true
    group.add(base)

    const glowGeo = new THREE.RingGeometry(0.2, 0.4, 28)
    const glowMat = new THREE.MeshBasicMaterial({
      color: flagColor,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide
    })
    const glow = new THREE.Mesh(glowGeo, glowMat)
    glow.rotation.x = -Math.PI / 2
    glow.position.set(0, 0.07, 0)
    glow.userData.isGlow = true
    group.add(glow)

    return group
  }

  /**
   * 显示/隐藏路径上的"选点"金色圆环（重新训练回放时用）。
   */
  setHighlightVisible(visible) {
    for (const cell of this.highlightCells || []) {
      cell.visible = visible
    }
  }

  /**
   * 显示/隐藏起点/终点旗标。
   */
  setMarkersVisible(visible) {
    if (this.startMarker) this.startMarker.visible = visible
    if (this.goalMarker) this.goalMarker.visible = visible
  }

  /**
   * 按当前地形高度重新摆放起点/终点旗标（地形起伏变化后调用）。
   */
  refreshMarkerHeights(terrainData) {
    if (!this.glbTerrain || !terrainData) return

    if (this.startMarker && Array.isArray(this._start)) {
      const [si, sj] = this._start
      const p = this.glbTerrain.gridToWorld(si, sj)
      this.startMarker.position.set(p.x, this._getSurfaceY(si, sj, terrainData), p.z)
    }

    if (this.goalMarker && Array.isArray(this._goal)) {
      const [gi, gj] = this._goal
      const p = this.glbTerrain.gridToWorld(gi, gj)
      this.goalMarker.position.set(p.x, this._getSurfaceY(gi, gj, terrainData), p.z)
    }
  }

  highlightPath(path, terrainData) {
    const targetPositions = []

    // 静态节点抽稀：保留起点、终点和中间每隔 STRIDE 的点；完整 path 仍用于动画
    const displayPath = path.filter((_, index) =>
      index === 0 || index === path.length - 1 || index % PATH_DISPLAY_STRIDE === 0
    )

    for (const point of displayPath) {
      const [i, j] = point
      const fi = Math.floor(i)
      const fj = Math.floor(j)
      // 统一坐标接口：GLB 模式用 targetSize，非 GLB 用 cellSize
      const p = this._getWorldSurfacePosition(fi, fj, terrainData)
      targetPositions.push({ x: p.x, y: p.y + 0.18, z: p.z })
    }

    const needCount = targetPositions.length
    const currentCount = this.highlightCells.length

    if (needCount > currentCount) {
      for (let i = currentCount; i < needCount; i++) {
        const geo = new THREE.RingGeometry(0.3, 0.55, 28)
        geo.rotateX(-Math.PI / 2)
        const mat = new THREE.MeshBasicMaterial({
          color: 0xfbbf24,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthTest: true,   // 开启深度测试，避免穿模显示
          depthWrite: false
        })
        const cell = new THREE.Mesh(geo, mat)
        cell.userData.targetOpacity = 0.55
        cell.userData.currentOpacity = 0
        if (this.mesh) {
          this.mesh.add(cell)
        }
        this.highlightCells.push(cell)
      }
    } else if (needCount < currentCount) {
      for (let i = needCount; i < currentCount; i++) {
        const cell = this.highlightCells[i]
        cell.userData.targetOpacity = 0
      }
    }

    for (let i = 0; i < needCount; i++) {
      const cell = this.highlightCells[i]
      const pos = targetPositions[i]
      cell.position.set(pos.x, pos.y, pos.z)
      cell.userData.targetOpacity = 0.55
      cell.visible = true
    }
  }

  updateHighlightAnim(delta) {
    const toRemove = []
    for (let i = 0; i < this.highlightCells.length; i++) {
      const cell = this.highlightCells[i]
      const target = cell.userData.targetOpacity || 0
      const current = cell.userData.currentOpacity || 0
      const diff = target - current
      const speed = 8 * delta
      const newOpacity = Math.abs(diff) < speed ? target : current + Math.sign(diff) * speed

      cell.userData.currentOpacity = newOpacity
      cell.material.opacity = newOpacity

      if (target <= 0.001 && newOpacity <= 0.001) {
        toRemove.push(i)
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      const idx = toRemove[i]
      const cell = this.highlightCells[idx]
      cell.parent?.remove(cell)
      if (cell.geometry) cell.geometry.dispose()
      if (cell.material) cell.material.dispose()
      this.highlightCells.splice(idx, 1)
    }
  }

  getWorldPos(i, j, terrainData) {
    const fi = Math.floor(i)
    const fj = Math.floor(j)
    return this._getWorldSurfacePosition(fi, fj, terrainData)
  }

  updateWindEffect(windSpeed, delta, time) {
    for (const grass of this.grassPatches) {
      const idx = grass.userData.grassIndex
      const sway = Math.sin(time * 2.2 + idx * 0.45) * windSpeed * 0.18 +
                   Math.sin(time * 3.8 + idx * 0.3) * windSpeed * 0.06
      grass.rotation.z = sway
      grass.rotation.x = Math.sin(time * 1.5 + idx * 0.6) * windSpeed * 0.04
    }

    for (const tree of this.treeGroups) {
      const idx = tree.userData.treeIndex
      const offset = tree.userData.swayOffset
      const sway = Math.sin(time * 1.2 + offset) * windSpeed * 0.08 +
                   Math.sin(time * 2.5 + offset * 1.5) * windSpeed * 0.03
      tree.rotation.z = sway
      tree.rotation.x = Math.sin(time * 1.8 + offset) * windSpeed * 0.03
    }

    if (this.startMarker) {
      const flagGroup = this.startMarker.children.find(c => c.userData && c.userData.flag)
      if (flagGroup) {
        const flag = flagGroup.userData.flag
        const positions = flag.geometry.attributes.position
        const arr = positions.array
        if (!flag.userData.originalZ) {
          flag.userData.originalZ = [...arr]
        }
        for (let i = 0; i < arr.length; i += 3) {
          const origZ = flag.userData.originalZ[i + 2]
          const xRatio = arr[i] / 0.75
          arr[i + 2] = origZ +
            Math.sin(time * 3.2 + xRatio * 4.5) * windSpeed * 0.1 * xRatio +
            Math.sin(time * 5.5 + xRatio * 3) * windSpeed * 0.04 * xRatio
        }
        positions.needsUpdate = true
      }
    }

    if (this.goalMarker) {
      const flagGroup = this.goalMarker.children.find(c => c.userData && c.userData.flag)
      if (flagGroup) {
        const flag = flagGroup.userData.flag
        const positions = flag.geometry.attributes.position
        const arr = positions.array
        if (!flag.userData.originalZ) {
          flag.userData.originalZ = [...arr]
        }
        for (let i = 0; i < arr.length; i += 3) {
          const origZ = flag.userData.originalZ[i + 2]
          const xRatio = arr[i] / 0.75
          arr[i + 2] = origZ +
            Math.sin(time * 3.2 + xRatio * 4.5) * windSpeed * 0.1 * xRatio +
            Math.sin(time * 5.5 + xRatio * 3) * windSpeed * 0.04 * xRatio
        }
        positions.needsUpdate = true
      }
    }
  }
}
