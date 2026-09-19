import * as THREE from 'three'

export class PathVisualizer {
  constructor(gridSize = 24, cellSize = 1, glbTerrain = null) {
    this.gridSize = gridSize
    this.cellSize = cellSize
    this.pathMesh = null
    this.flowOffset = 0
    this.movingDot = null
    this.glbTerrain = glbTerrain  // GLB 地形引用，用于从模型表面采样高度
  }

  build(path, terrainData, terrain, segments, options = {}) {
    this.clear()

    // 统一坐标链路：优先走 glbTerrain.gridPathToWorldPath，
    // 禁止再使用 j-12 / j*cellSize 等硬编码（除非无 GLB 地形）。
    let worldPoints = []
    if (this.glbTerrain?.gridPathToWorldPath) {
      worldPoints = this.glbTerrain.gridPathToWorldPath(path, options.lift ?? 0.16)
    } else {
      // 无 GLB 地形的兜底（几乎不会走到）
      worldPoints = (path || [])
        .filter(p => Array.isArray(p) && p.length >= 2)
        .map(p => {
          const row = Number(p[0]); const col = Number(p[1])
          if (!Number.isFinite(row) || !Number.isFinite(col)) return null
          return new THREE.Vector3(col * this.cellSize, 0, row * this.cellSize)
        })
        .filter(Boolean)
    }

    if (worldPoints.length < 2) {
      console.warn('有效路径点不足，取消路径渲染')
      return null
    }

    const group = new THREE.Group()

    // 一条连续、去重、贴地的细线，而不是每段独立立体管
    const line = this.buildRouteLine(worldPoints, options.color ?? 0x86efac)
    if (line) group.add(line)

    // 整体曲线用于移动小球遍历动画
    const curve = new THREE.CatmullRomCurve3(worldPoints, false, 'centripetal')
    this._curve = curve

    // 发光小球（仅用于 3D 战术推演的走位动画）
    const dotGroup = new THREE.Group()
    const dotGeo = new THREE.SphereGeometry(0.11, 16, 16)
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xfef3c7, transparent: true, opacity: 1 })
    this.movingDot = new THREE.Mesh(dotGeo, dotMat)
    dotGroup.add(this.movingDot)

    const dotGlowGeo = new THREE.SphereGeometry(0.18, 16, 16)
    const dotGlowMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending
    })
    this.dotGlow = new THREE.Mesh(dotGlowGeo, dotGlowMat)
    dotGroup.add(this.dotGlow)

    group.add(dotGroup)
    this.pathMesh = group

    return this.pathMesh
  }

  /**
   * 用一组贴地世界点构建一条连续细线（正式救援路径）。
   */
  buildRouteLine(points, color = 0x86efac) {
    if (!points || points.length < 2) return null

    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
    const geometry = new THREE.TubeGeometry(curve, Math.max(24, points.length * 4), 0.09, 12, false)
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.renderOrder = 12
    return mesh
  }

  _safeHeight(x, z, fallbackY = 0) {
    const h = this.glbTerrain?.getHeight?.(x, z)
    if (!Number.isFinite(h)) {
      return Number.isFinite(fallbackY) ? fallbackY : 0
    }
    return THREE.MathUtils.clamp(h, -20, 20)
  }

  _getTerrainHeightAt(fi, fj, terrainData, terrain) {
    if (this.glbTerrain) {
      const p = this.glbTerrain.gridToWorld(fi, fj)
      const y = this._safeHeight(p.x, p.z, p.y)
      return { x: p.x, y, z: p.z }
    }

    const gs = terrain.gridSize
    const cs = terrain.cellSize
    const half = (gs * cs) / 2
    const x = fj * cs - half + cs / 2
    const z = fi * cs - half + cs / 2

    // 回退到程序化地形高度
    const i0 = Math.max(0, Math.min(gs - 1, Math.floor(fi)))
    const j0 = Math.max(0, Math.min(gs - 1, Math.floor(fj)))
    const i1 = Math.max(0, Math.min(gs - 1, i0 + 1))
    const j1 = Math.max(0, Math.min(gs - 1, j0 + 1))
    const ti = fi - i0
    const tj = fj - j0

    const h00 = terrainData[i0][j0]
    const h10 = terrainData[i1][j0]
    const h01 = terrainData[i0][j1]
    const h11 = terrainData[i1][j1]

    const h = h00 * (1 - ti) * (1 - tj) +
              h10 * ti * (1 - tj) +
              h01 * (1 - ti) * tj +
              h11 * ti * tj

    const y = Number.isFinite(h) ? h * 0.5 : 0

    return { x, y: Number.isFinite(y) ? y : 0, z }
  }

  update(delta) {
    if (!this.movingDot || !this._curve) return

    this.flowOffset += delta * 0.25
    if (this.flowOffset > 1) this.flowOffset = 0

    const pos = this._curve.getPointAt(this.flowOffset)
    this.movingDot.position.copy(pos)
    this.dotGlow.position.copy(pos)

    const pulse = 0.85 + Math.sin(this.flowOffset * Math.PI * 2) * 0.15
    this.movingDot.scale.setScalar(pulse)
    this.dotGlow.scale.setScalar(1 + pulse * 0.3)

    if (this.trail && this.trail.material) {
      this.trail.material.opacity = 0.15 + Math.sin(this.flowOffset * Math.PI * 2) * 0.1
    }
  }

  // 一次性从起点走到终点，返回 Promise，便于播放流程等待
  animateTraversal(durationMs = 2000) {
    return new Promise((resolve) => {
      if (!this._curve || !this.movingDot) {
        resolve()
        return
      }
      const start = performance.now()
      const tick = (now) => {
        const t = Math.min((now - start) / durationMs, 1)
        const pos = this._curve.getPointAt(t)
        this.movingDot.position.copy(pos)
        this.dotGlow.position.copy(pos)
        if (this.trail && this.trail.material) {
          this.trail.material.opacity = 0.15 + Math.sin(t * Math.PI) * 0.1
        }
        if (t < 1) {
          requestAnimationFrame(tick)
        } else {
          resolve()
        }
      }
      requestAnimationFrame(tick)
    })
  }

  clear() {
    if (this.pathMesh) {
      this.pathMesh.parent?.remove(this.pathMesh)
      this.pathMesh.traverse((child) => {
        if (child.geometry) child.geometry.dispose()
        if (child.material) child.material.dispose()
      })
      this.pathMesh = null
    }
    this.movingDot = null
    this.dotGlow = null
    this.trail = null
    this._curve = null
  }
}
