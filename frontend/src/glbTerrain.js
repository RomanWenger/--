import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * GLB 地形模型 —— 统一高度场
 *
 * 职责：
 *   1. 加载主 GLB（model_shaded.glb）作为口岸局部地形骨架
 *   2. 提供统一的 getHeight(x, z) 接口，供路径、泥石流、标记共用
 *   3. 支持 0~2 地形起伏参数（setTerrainFactor），仅改变 Y 轴尺度
 *
 * 高度场缓存：加载完成后预采样 128×128 网格，运行时双线性插值，
 * 避免每帧对每个粒子做射线检测。
 */
export class GLBTerrain {
  constructor(gridSize = 20, cellSize = 1.8, options = {}) {
    this.gridSize = gridSize
    this.cellSize = cellSize
    this.targetSize = options.targetSize ?? 24
    this.baseHeightFactor = options.heightFactor ?? 3.2
    this.terrainFactor = 1.0  // 0~2，1为真实基准

    this.mesh = null
    this.modelRoot = null
    this.raycaster = new THREE.Raycaster()

    // 初始变换（用于 setTerrainFactor 时重置，避免重复累加位移）
    this._basePosition = new THREE.Vector3()
    this._baseScale = new THREE.Vector3()

    // 高度场缓存（64×64，边界复杂的 GLB 需要更高分辨率才不会误判）
    this._hfResolution = 64
    this._heightField = null       // Float32Array(res*res)
    this._heightFieldValid = null  // Uint8Array(res*res)，1=该采样点命中 GLB 表面
    this._hfMin = new THREE.Vector2()
    this._hfMax = new THREE.Vector2()
    this._hfSize = new THREE.Vector2()

    // 8×8 网格锚点：每个网格点吸附到最近的真实地形表面，避免包围盒角点落在模型外
    this._gridSurfaceAnchors = null

    // 基准高度场（只采样一次，滑块变化时不重新射线检测）
    this._baseHeightField = null
    this._terrainHeightRatio = 1.0
    // 模型底部在世界 Y 轴的偏移（缩放归零后记录），保证路径高度和模型表面同步
    this._terrainBaseY = 0

    // 表面选择模式：highest(最高交点) / lowest(最低交点) / first(第一个交点)
    // GLB 模型上下表面都可能被射线命中，取最高交点确保路径贴在山体可见的正面
    this.surfaceMode = 'highest'

    // GLB 实际包围盒范围（load 后填充），用于 gridToWorld 精确映射
    this._worldMinX = -12
    this._worldMaxX = 12
    this._worldMinZ = -12
    this._worldMaxZ = 12

    // 高度场就绪 Promise（异步构建完成后 resolve）
    this._heightFieldReady = Promise.resolve()
  }

  /**
   * 返回一个 Promise，在高度场异步构建完成后 resolve
   */
  whenHeightFieldReady() {
    return this._heightFieldReady
  }

  /**
   * 导出指定分辨率的 DEM（归一化高程 0-1），供后端危险场计算使用
   * 在高度场就绪后调用，采样真实 GLB 表面高度
   */
  exportDEM(resolution = 20) {
    const dem = []
    for (let i = 0; i < resolution; i++) {
      const row = []
      for (let j = 0; j < resolution; j++) {
        // 用锚点映射保证采样点在真实表面上
        const p = this.gridToWorld(i, j)
        const h = this.getHeight(p.x, p.z)
        row.push(h)
      }
      dem.push(row)
    }
    // 归一化到 0-1
    let min = Infinity, max = -Infinity
    for (const row of dem) for (const v of row) { if (v < min) min = v; if (v > max) max = v }
    const rng = Math.max(max - min, 1e-6)
    return dem.map(row => row.map(v => (v - min) / rng))
  }

  /**
   * 加载主 GLB 模型
   */
  async load(modelPath = './models/model_shaded.glb', transformMatrix = null) {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader()
      console.log('[GLBTerrain] 开始加载 GLB:', modelPath)
      loader.load(modelPath, gltf => {
        console.log('[GLBTerrain] GLB 加载成功，开始处理模型...')
        const root = gltf.scene

        // 只启用阴影，保留 GLB 原始材质
        root.traverse(obj => {
          if (!obj.isMesh) return
          obj.castShadow = true
          obj.receiveShadow = true

          // 隐藏底座/平面/地面等辅助几何，避免灰色三角面
          const name = (obj.name || '').toLowerCase()
          if (name.includes('base') || name.includes('bottom') ||
              name.includes('plane') || name.includes('ground') ||
              name.includes('helper')) {
            obj.visible = false
            return
          }

          // 只渲染正面，消除背面法线异常导致的灰色面
          if (obj.material) {
            if (Array.isArray(obj.material)) {
              obj.material.forEach(mat => { mat.side = THREE.FrontSide })
            } else {
              obj.material.side = THREE.FrontSide
            }
          }
        })

        // transform_matrix.json 的 Y 轴为负，会翻转模型，不应用
        const box = new THREE.Box3().setFromObject(root)
        const size = new THREE.Vector3()
        const center = new THREE.Vector3()
        box.getSize(size)
        box.getCenter(center)

        const maxDim = Math.max(size.x, size.z)
        const scale = this.targetSize / maxDim
        const hf = this.baseHeightFactor * this.terrainFactor

        // 水平等比缩放，垂直方向按地形因子增强
        root.scale.set(scale, scale * hf, scale)
        root.position.x = -center.x * scale
        root.position.z = -center.z * scale
        root.position.y = -center.y * scale * hf

        const scaledBox = new THREE.Box3().setFromObject(root)
        root.position.y -= scaledBox.min.y  // 底部落在 y=0

        // 保存初始变换
        this._basePosition.copy(root.position)
        this._baseScale.copy(root.scale)

        const finalBox = new THREE.Box3().setFromObject(root)
        console.log('[GLBTerrain] 最终尺寸:',
          (finalBox.max.x - finalBox.min.x).toFixed(2),
          (finalBox.max.y - finalBox.min.y).toFixed(2),
          (finalBox.max.z - finalBox.min.z).toFixed(2),
          'terrainFactor:', this.terrainFactor)

        // 保存 GLB 实际 X/Z 范围，gridToWorld 用它精确映射，不再假定 24×24
        this._worldMinX = finalBox.min.x
        this._worldMaxX = finalBox.max.x
        this._worldMinZ = finalBox.min.z
        this._worldMaxZ = finalBox.max.z
        console.log('[GLBTerrain] world bounds:', {
          x: [this._worldMinX.toFixed(2), this._worldMaxX.toFixed(2)],
          z: [this._worldMinZ.toFixed(2), this._worldMaxZ.toFixed(2)]
        })

        // 统一更新矩阵并校验几何：无效(含 NaN/Infinity)的网格隐藏，避免黑色切面
        root.updateMatrixWorld(true)
        root.traverse((child) => {
          if (!child.isMesh || !child.geometry) return
          const geometry = child.geometry
          geometry.computeBoundingBox()
          geometry.computeBoundingSphere()
          const position = geometry.getAttribute('position')
          if (!position) return
          let valid = true
          for (let i = 0; i < position.count; i++) {
            const x = position.getX(i)
            const y = position.getY(i)
            const z = position.getZ(i)
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
              valid = false
              break
            }
          }
          if (!valid) {
            console.warn('发现无效 GLB 几何体:', child.name)
            child.visible = false
            return
          }
          child.frustumCulled = true
        })

        this.modelRoot = root
        this.mesh = root

        // 先给一个全零高度场兜底，让模型立即显示，避免页面黑屏
        this._heightField = new Float32Array(this._hfResolution * this._hfResolution)
        this._baseHeightField = new Float32Array(this._heightField)
        this._terrainHeightRatio = 1.0
        this._terrainBaseY = root.position.y

        // 模型立即可用，高度场在后台异步构建（分段执行不卡主线程）
        resolve(root)

        // 后台异步构建真实高度场
        this._heightFieldReady = this._buildHeightFieldAsync(finalBox).then(() => {
          this._baseHeightField = new Float32Array(this._heightField)
          console.log('[GLBTerrain] 高度场异步构建完成')
        }).catch(e => {
          console.error('[GLBTerrain] 高度场构建失败:', e)
        })
      }, undefined, reject)
    })
  }

  /**
   * 异步分段构建高度场缓存：每帧处理 ROWS_PER_FRAME 行，不卡主线程
   * 取同一 (x,z) 下最高的有效交点，避免取到模型底面或内侧面
   */
  async _buildHeightFieldAsync(box) {
    const res = this._hfResolution
    const minX = box.min.x
    const maxX = box.max.x
    const minZ = box.min.z
    const maxZ = box.max.z

    this._hfMin.set(minX, minZ)
    this._hfMax.set(maxX, maxZ)
    this._hfSize.set(maxX - minX, maxZ - minZ)

    const field = new Float32Array(res * res)
    const valid = new Uint8Array(res * res)
    const origin = new THREE.Vector3()
    const dir = new THREE.Vector3(0, -1, 0)
    this.raycaster.near = 0
    this.raycaster.far = 300

    // 打印包围盒，确认 Y 轴确实是山体起伏方向
    console.log('[GLBTerrain] bounds:', {
      min: box.min.toArray().map(v => v.toFixed(2)),
      max: box.max.toArray().map(v => v.toFixed(2)),
      size: [
        (box.max.x - box.min.x).toFixed(2),
        (box.max.y - box.min.y).toFixed(2),
        (box.max.z - box.min.z).toFixed(2)
      ]
    })

    const ROWS_PER_FRAME = 2  // 每帧处理 2 行，平衡速度与流畅度

    for (let i = 0; i < res; i++) {
      const z = minZ + (maxZ - minZ) * (i / (res - 1))
      for (let j = 0; j < res; j++) {
        const x = minX + (maxX - minX) * (j / (res - 1))
        origin.set(x, box.max.y + 100, z)
        this.raycaster.set(origin, dir)
        const hits = this.raycaster.intersectObject(this.modelRoot, true)
        const index = i * res + j
        field[index] = this._getSurfaceHitY(hits)
        valid[index] = hits.length > 0 ? 1 : 0
      }
      // 每处理 ROWS_PER_FRAME 行让出主线程
      if ((i + 1) % ROWS_PER_FRAME === 0) {
        await new Promise(r => setTimeout(r, 0))
      }
    }

    this._heightField = field
    this._heightFieldValid = valid

    // 打印高度场统计
    let maxY = -Infinity, minY = Infinity
    for (let i = 0; i < field.length; i++) {
      if (field[i] > maxY) maxY = field[i]
      if (field[i] < minY) minY = field[i]
    }
    console.log('[GLBTerrain] height field range:',
      'min=' + minY.toFixed(2),
      'max=' + maxY.toFixed(2),
      'range=' + (maxY - minY).toFixed(2),
      'surfaceMode=' + this.surfaceMode)

    // 构建 8×8 网格锚点：把每个网格点吸附到最近的真实地形表面
    this._buildGridSurfaceAnchors()
  }

  /**
   * 从世界坐标 (x,z) 找到最近的有效地形表面点
   * 用于把包围盒角点（可能在模型外）吸附到真实山体表面
   */
  _findNearestSurfacePoint(x, z) {
    if (!this._heightFieldValid) return null

    const res = this._hfResolution
    const px = Math.round(
      THREE.MathUtils.clamp((x - this._hfMin.x) / this._hfSize.x, 0, 1) * (res - 1)
    )
    const pz = Math.round(
      THREE.MathUtils.clamp((z - this._hfMin.y) / this._hfSize.y, 0, 1) * (res - 1)
    )

    let bestIndex = -1
    let bestDistance = Infinity

    for (let radius = 0; radius < res; radius++) {
      const minZ = Math.max(0, pz - radius)
      const maxZ = Math.min(res - 1, pz + radius)
      const minX = Math.max(0, px - radius)
      const maxX = Math.min(res - 1, px + radius)

      for (let iz = minZ; iz <= maxZ; iz++) {
        for (let ix = minX; ix <= maxX; ix++) {
          const index = iz * res + ix
          if (!this._heightFieldValid[index]) continue
          const distance = (ix - px) ** 2 + (iz - pz) ** 2
          if (distance < bestDistance) {
            bestDistance = distance
            bestIndex = index
          }
        }
      }
      if (bestIndex >= 0) break
    }

    if (bestIndex < 0) return null

    const ix = bestIndex % res
    const iz = Math.floor(bestIndex / res)
    return {
      x: THREE.MathUtils.lerp(this._hfMin.x, this._hfMax.x, ix / (res - 1)),
      y: this._heightField[bestIndex],
      z: THREE.MathUtils.lerp(this._hfMin.y, this._hfMax.y, iz / (res - 1))
    }
  }

  /**
   * 构建 gridSize×gridSize 的网格表面锚点
   * 每个网格点先映射到包围盒，再吸附到最近的真实地形表面
   */
  _buildGridSurfaceAnchors() {
    const anchors = []
    const maxIndex = this.gridSize - 1

    for (let i = 0; i < this.gridSize; i++) {
      const row = []
      for (let j = 0; j < this.gridSize; j++) {
        const u = j / maxIndex
        const v = i / maxIndex
        const x = THREE.MathUtils.lerp(this._worldMinX, this._worldMaxX, u)
        const z = THREE.MathUtils.lerp(this._worldMinZ, this._worldMaxZ, v)
        const point = this._findNearestSurfacePoint(x, z)
        row.push(point || { x, y: 0, z })
      }
      anchors.push(row)
    }
    this._gridSurfaceAnchors = anchors
    console.log('[GLBTerrain] grid surface anchors built, sample corners:',
      anchors[0][0], anchors[0][maxIndex], anchors[maxIndex][0], anchors[maxIndex][maxIndex])
  }

  /**
   * 根据 surfaceMode 从射线交点中选取表面高度
   * - highest: 取最高交点（默认，路径贴山体可见正面）
   * - lowest:  取最低交点
   * - first:   取第一个交点（Three.js 按距离排序的最近交点）
   */
  _getSurfaceHitY(hits) {
    if (!hits || !hits.length) return 0

    if (this.surfaceMode === 'highest') {
      let highest = hits[0].point.y
      for (let k = 1; k < hits.length; k++) {
        if (hits[k].point.y > highest) highest = hits[k].point.y
      }
      return highest
    }

    if (this.surfaceMode === 'lowest') {
      let lowest = hits[0].point.y
      for (let k = 1; k < hits.length; k++) {
        if (hits[k].point.y < lowest) lowest = hits[k].point.y
      }
      return lowest
    }

    return hits[0].point.y
  }

  /**
   * 切换表面选择模式，并立即重建高度场
   * @param {'highest'|'lowest'|'first'} mode
   */
  setSurfaceMode(mode) {
    if (!['highest', 'lowest', 'first'].includes(mode)) {
      console.warn('[GLBTerrain] 未知 surfaceMode:', mode, '，使用 highest')
      this.surfaceMode = 'highest'
    } else {
      this.surfaceMode = mode
    }

    // 重新采样高度场（如果模型已加载，异步执行不卡主线程）
    if (this.modelRoot) {
      const box = new THREE.Box3().setFromObject(this.modelRoot)
      this._buildHeightFieldAsync(box).then(() => {
        this._baseHeightField = new Float32Array(this._heightField)
      })
    }
  }

  /**
   * 获取世界坐标 (x, z) 处的地表高度（双线性插值）
   * 所有路径、泥石流、标记都应通过这个接口取高度
   */
  getHeight(x, z) {
    if (!this._heightField) return 0

    const res = this._hfResolution
    const fx = (x - this._hfMin.x) / this._hfSize.x
    const fz = (z - this._hfMin.y) / this._hfSize.y

    const px = fx * (res - 1)
    const pz = fz * (res - 1)

    const x0 = Math.max(0, Math.min(res - 2, Math.floor(px)))
    const z0 = Math.max(0, Math.min(res - 2, Math.floor(pz)))
    const tx = px - x0
    const tz = pz - z0

    const idx00 = z0 * res + x0
    const idx10 = z0 * res + x0 + 1
    const idx01 = (z0 + 1) * res + x0
    const idx11 = (z0 + 1) * res + x0 + 1

    // 双线性插值时只使用有效命中的采样点，避免把模型外的 0 混入
    let sumH = 0, sumW = 0
    const corners = [
      { h: this._heightField[idx00], v: this._heightFieldValid ? this._heightFieldValid[idx00] : 1, w: (1 - tx) * (1 - tz) },
      { h: this._heightField[idx10], v: this._heightFieldValid ? this._heightFieldValid[idx10] : 1, w: tx * (1 - tz) },
      { h: this._heightField[idx01], v: this._heightFieldValid ? this._heightFieldValid[idx01] : 1, w: (1 - tx) * tz },
      { h: this._heightField[idx11], v: this._heightFieldValid ? this._heightFieldValid[idx11] : 1, w: tx * tz }
    ]
    for (const c of corners) {
      if (c.v) { sumH += c.h * c.w; sumW += c.w }
    }

    let baseHeight
    if (sumW > 0) {
      baseHeight = sumH / sumW
    } else {
      // 四个角都无效，退回最近有效点
      const pt = this._findNearestSurfacePoint(x, z)
      baseHeight = pt ? pt.y : 0
    }

    // 乘以当前地形高度比例，避免滑块变化时重新射线采样
    return baseHeight * this._terrainHeightRatio
  }

  /**
   * 设置地形起伏因子（0~2）
   * 0：平缓教学视图，1：真实基准，2：高差强化
   * 只改变 Y 轴尺度，XZ 不变，路径坐标不受影响
   */
  setTerrainFactor(value) {
    const factor = THREE.MathUtils.clamp(Number(value), 0, 2)
    if (!this.modelRoot || !this._baseHeightField) return

    this.terrainFactor = factor

    // 滑块 0：真实高度的 65%；1：100%；2：135%
    const ratio = 0.65 + factor * 0.35
    this._terrainHeightRatio = ratio

    // 只改变模型垂直缩放，不做射线检测（高度场由 getHeight 乘比例实现）
    this.modelRoot.position.copy(this._basePosition)
    this.modelRoot.scale.copy(this._baseScale)
    this.modelRoot.scale.y = this._baseScale.y * ratio

    // 缩放后重新把底部放回 y=0
    const box = new THREE.Box3().setFromObject(this.modelRoot)
    this.modelRoot.position.y -= box.min.y
    // 记录缩放后的底部偏移（高度场已包含绝对世界高度，此处仅用于调试）
    this._terrainBaseY = this.modelRoot.position.y
  }

  /**
   * 网格坐标 (i, j) → 世界坐标 (x, y, z)
   * 使用 8×8 网格表面锚点做双线性插值，确保端点和中间点都落在真实地形表面上
   * （包围盒角点可能在模型外，锚点会先吸附到最近的有效表面点）
   */
  gridToWorld(i, j) {
    const maxIndex = this.gridSize - 1

    // 高度场未就绪时回退到包围盒线性映射
    if (!this._gridSurfaceAnchors) {
      const half = this.targetSize / 2
      const step = this.targetSize / maxIndex
      return new THREE.Vector3(j * step - half, 0, i * step - half)
    }

    const fi = THREE.MathUtils.clamp(i, 0, maxIndex)
    const fj = THREE.MathUtils.clamp(j, 0, maxIndex)

    const i0 = Math.min(maxIndex - 1, Math.floor(fi))
    const j0 = Math.min(maxIndex - 1, Math.floor(fj))
    const ti = fi - i0
    const tj = fj - j0

    const p00 = this._gridSurfaceAnchors[i0][j0]
    const p10 = this._gridSurfaceAnchors[i0 + 1][j0]
    const p01 = this._gridSurfaceAnchors[i0][j0 + 1]
    const p11 = this._gridSurfaceAnchors[i0 + 1][j0 + 1]

    const x = p00.x * (1 - ti) * (1 - tj) + p10.x * ti * (1 - tj) +
              p01.x * (1 - ti) * tj + p11.x * ti * tj
    const y = p00.y * (1 - ti) * (1 - tj) + p10.y * ti * (1 - tj) +
              p01.y * (1 - ti) * tj + p11.y * ti * tj
    const z = p00.z * (1 - ti) * (1 - tj) + p10.z * ti * (1 - tj) +
              p01.z * (1 - ti) * tj + p11.z * ti * tj

    return new THREE.Vector3(x, y, z)
  }

  /**
   * 网格坐标 (i, j) 处的地表高度（射线检测，带缓存）
   * 路径点使用
   */
  getSurfaceHeight(i, j) {
    if (!this.modelRoot) return 0
    const p = this.gridToWorld(i, j)
    return this.getHeight(p.x, p.z)
  }

  /**
   * 网格坐标 (i, j) 处的贴地世界坐标
   */
  getSurfacePosition(i, j) {
    const p = this.gridToWorld(i, j)
    const y = this.getHeight(p.x, p.z)
    return { x: p.x, y, z: p.z }
  }

  /**
   * 统一坐标链路：把后端 [row, col] 路径数组转换为贴地世界坐标点列。
   * 全项目（PathVisualizer / TrainingReplay / 3D 战术推演）唯一入口，
   * 禁止再自行使用 Vector3(j-12, 0, i-12) 或 j*cellSize 等硬编码。
   *
   * - 过滤越界 / 非有限 / NaN 点
   * - 采样失败跳过
   * - 删除连续重复点（避免 TubeGeometry/折线产生折返尖刺）
   *
   * @param {Array} path [[row, col], ...]
   * @param {number} [lift] 抬离地表高度（米）
   * @returns {THREE.Vector3[]}
   */
  gridPathToWorldPath(path, lift = 0.16) {
    const out = []
    if (!Array.isArray(path) || path.length < 2) return out

    const maxGridIndex = Math.max(1, this.gridSize - 1)
    let previous = null

    for (const cell of path) {
      const row = Number(cell?.[0])
      const col = Number(cell?.[1])

      if (
        !Number.isFinite(row) || !Number.isFinite(col) ||
        row < 0 || col < 0 || row > maxGridIndex || col > maxGridIndex
      ) {
        continue
      }

      const point = this.gridToWorld(row, col)
      if (!point) continue

      const terrainHeight = this.getHeight(point.x, point.z)
      if (!Number.isFinite(terrainHeight)) continue

      const worldPoint = new THREE.Vector3(
        point.x,
        terrainHeight + lift,
        point.z
      )

      if (!previous || previous.distanceToSquared(worldPoint) > 0.0004) {
        out.push(worldPoint)
        previous = worldPoint
      }
    }

    return out
  }

  addToScene(scene) {
    if (this.mesh) scene.add(this.mesh)
  }

  clearCache() {
    // 兼容旧调用
  }
}
