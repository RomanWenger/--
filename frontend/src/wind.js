import * as THREE from 'three'

export class WindParticles {
  constructor(gridSize = 24, cellSize = 1.8) {
    this.gridSize = gridSize
    this.cellSize = cellSize
    this.windSpeed = 0.5
    this.particleCount = 1800
    this.points = null
    this.velocities = null
    this.streaks = null
    this.windIndicator = null
    this.turbulenceOffset = 0
    this._init()
  }

  _init() {
    this._createParticles()
    this._createStreaks()
    this._createGroundWind()
    this._createWindIndicator()
  }

  _createParticles() {
    const geometry = new THREE.BufferGeometry()
    const positions = new Float32Array(this.particleCount * 3)
    const colors = new Float32Array(this.particleCount * 3)
    const sizes = new Float32Array(this.particleCount)
    this.velocities = new Float32Array(this.particleCount * 3)
    this.particleOffsets = new Float32Array(this.particleCount)

    const halfSize = this.gridSize * this.cellSize * 0.65

    for (let i = 0; i < this.particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * halfSize * 2
      positions[i * 3 + 1] = Math.random() * 9 + 0.4
      positions[i * 3 + 2] = (Math.random() - 0.5) * halfSize * 2

      const heightRatio = positions[i * 3 + 1] / 9
      const shade = 0.3 + (1 - heightRatio) * 0.5 + Math.random() * 0.2
      colors[i * 3] = 0.35 * shade
      colors[i * 3 + 1] = 0.6 * shade
      colors[i * 3 + 2] = 1.0 * shade

      sizes[i] = (0.03 + Math.random() * 0.07) * (0.5 + heightRatio * 0.8)

      this.velocities[i * 3] = (Math.random() - 0.5) * 0.8
      this.velocities[i * 3 + 1] = (Math.random() - 0.3) * 0.4
      this.velocities[i * 3 + 2] = 0

      this.particleOffsets[i] = Math.random() * Math.PI * 2
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1))

    const material = new THREE.PointsMaterial({
      size: 0.09,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      depthWrite: false
    })

    this.points = new THREE.Points(geometry, material)
  }

  _createStreaks() {
    const streakCount = 200
    const positions = new Float32Array(streakCount * 6)
    const colors = new Float32Array(streakCount * 6)
    this.streakData = []

    const halfSize = this.gridSize * this.cellSize * 0.65

    for (let i = 0; i < streakCount; i++) {
      const x = (Math.random() - 0.5) * halfSize * 2
      const y = Math.random() * 8 + 0.6
      const z = (Math.random() - 0.5) * halfSize * 2
      const len = 0.15 + Math.random() * 0.5

      positions[i * 6] = x
      positions[i * 6 + 1] = y
      positions[i * 6 + 2] = z
      positions[i * 6 + 3] = x
      positions[i * 6 + 4] = y
      positions[i * 6 + 5] = z + len

      const heightRatio = y / 8
      const alpha = 0.15 + (1 - heightRatio) * 0.45 + Math.random() * 0.2

      colors[i * 6] = 0.25 + (1 - heightRatio) * 0.2
      colors[i * 6 + 1] = 0.5 + (1 - heightRatio) * 0.2
      colors[i * 6 + 2] = 1.0
      colors[i * 6 + 3] = 0.25 + (1 - heightRatio) * 0.2
      colors[i * 6 + 4] = 0.5 + (1 - heightRatio) * 0.2
      colors[i * 6 + 5] = 1.0

      this.streakData.push({
        speed: 0.6 + Math.random() * 1.8,
        len: len,
        baseY: y,
        baseX: x,
        turbulence: 0.2 + Math.random() * 0.5,
        offset: Math.random() * Math.PI * 2,
        yOffset: Math.random() * Math.PI * 2
      })
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })

    this.streaks = new THREE.LineSegments(geometry, material)
  }

  _createGroundWind() {
    const count = 90
    const positions = new Float32Array(count * 6)
    const colors = new Float32Array(count * 6)
    this.groundWindData = []

    const halfSize = this.gridSize * this.cellSize * 0.6

    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * halfSize * 2
      const y = 0.15 + Math.random() * 0.4
      const z = (Math.random() - 0.5) * halfSize * 2
      const len = 0.3 + Math.random() * 0.8

      positions[i * 6] = x
      positions[i * 6 + 1] = y
      positions[i * 6 + 2] = z
      positions[i * 6 + 3] = x
      positions[i * 6 + 4] = y
      positions[i * 6 + 5] = z + len

      const alpha = 0.3 + Math.random() * 0.4
      colors[i * 6] = 0.2
      colors[i * 6 + 1] = 0.4
      colors[i * 6 + 2] = 0.8
      colors[i * 6 + 3] = 0.2
      colors[i * 6 + 4] = 0.4
      colors[i * 6 + 5] = 0.8

      this.groundWindData.push({
        speed: 1.0 + Math.random() * 2.0,
        len: len,
        baseY: y,
        baseX: x,
        offset: Math.random() * Math.PI * 2
      })
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })

    this.groundWind = new THREE.LineSegments(geometry, material)
  }

  _createWindIndicator() {
    const group = new THREE.Group()

    const arrowGroup = new THREE.Group()

    const shaftGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.5, 8)
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      emissive: 0x3b82f6,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.9
    })
    const shaft = new THREE.Mesh(shaftGeo, shaftMat)
    shaft.rotation.x = Math.PI / 2
    arrowGroup.add(shaft)

    const headGeo = new THREE.ConeGeometry(0.18, 0.4, 8)
    const headMat = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      emissive: 0x3b82f6,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.95
    })
    const head = new THREE.Mesh(headGeo, headMat)
    head.position.set(0, 0, 0.95)
    head.rotation.x = Math.PI / 2
    arrowGroup.add(head)

    arrowGroup.rotation.x = -Math.PI / 2
    group.add(arrowGroup)

    const ringGeo = new THREE.TorusGeometry(0.5, 0.03, 8, 32)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.5
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.y = Math.PI / 2
    group.add(ring)

    const ring2Geo = new THREE.TorusGeometry(0.7, 0.02, 8, 32)
    const ring2Mat = new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.3
    })
    const ring2 = new THREE.Mesh(ring2Geo, ring2Mat)
    ring2.rotation.y = Math.PI / 2
    group.add(ring2)
    this.indicatorRing2 = ring2

    const halfSize = this.gridSize * this.cellSize * 0.6
    group.position.set(halfSize - 0.5, 4.5, 0)
    group.userData.baseY = 4.5

    this.windIndicator = group
  }

  setWindSpeed(speed) {
    this.windSpeed = speed

    if (this.points) {
      this.points.material.opacity = 0.3 + speed * 0.5
    }
    if (this.streaks) {
      this.streaks.material.opacity = 0.15 + speed * 0.55
    }
    if (this.groundWind) {
      this.groundWind.material.opacity = 0.2 + speed * 0.6
    }
  }

  _turbulence(x, y, z, time, scale = 1) {
    const t = time * 0.5
    return (
      Math.sin(x * scale + t) *
      Math.sin(y * scale * 0.7 + t * 0.8) *
      Math.sin(z * scale * 0.5 + t * 1.2)
    )
  }

  update(delta, time) {
    this.turbulenceOffset += delta * 0.3
    if (!this.points || !this.streaks) return

    const positions = this.points.geometry.attributes.position.array
    const halfSize = this.gridSize * this.cellSize * 0.65
    const speed = this.windSpeed * 8

    for (let i = 0; i < this.particleCount; i++) {
      const idx = i * 3
      const offset = this.particleOffsets[i]

      const turbX = this._turbulence(
        positions[idx] * 0.5,
        positions[idx + 1] * 0.3,
        positions[idx + 2] * 0.5,
        time + offset,
        0.8
      ) * 0.5

      const turbY = this._turbulence(
        positions[idx] * 0.4 + 10,
        positions[idx + 1] * 0.5,
        positions[idx + 2] * 0.4 + 5,
        time * 0.7 + offset,
        0.6
      ) * 0.3

      positions[idx] += (this.velocities[idx] + turbX) * delta * speed * 0.25
      positions[idx + 1] += (this.velocities[idx + 1] + turbY) * delta * 0.6
      positions[idx + 2] += speed * delta * (0.5 + Math.sin(i * 0.08 + time * 0.5 + offset) * 0.3 + Math.abs(turbX) * 0.3)

      if (positions[idx + 2] > halfSize) {
        positions[idx + 2] = -halfSize
        positions[idx] = (Math.random() - 0.5) * halfSize * 2
        positions[idx + 1] = Math.random() * 9 + 0.4
      }

      if (positions[idx + 1] > 9.5) {
        positions[idx + 1] = 0.4
        positions[idx] = (Math.random() - 0.5) * halfSize * 2
      }
      if (positions[idx + 1] < 0.3) {
        positions[idx + 1] = 0.3
        this.velocities[idx + 1] = Math.abs(this.velocities[idx + 1])
      }

      if (positions[idx] > halfSize) {
        positions[idx] = -halfSize
      }
      if (positions[idx] < -halfSize) {
        positions[idx] = halfSize
      }
    }

    this.points.geometry.attributes.position.needsUpdate = true

    const streakPositions = this.streaks.geometry.attributes.position.array
    const streakCount = this.streakData.length

    for (let i = 0; i < streakCount; i++) {
      const data = this.streakData[i]
      const idx = i * 6
      const moveSpeed = speed * data.speed * delta

      const turbX = this._turbulence(
        streakPositions[idx] * 0.6,
        streakPositions[idx + 1] * 0.4,
        streakPositions[idx + 2] * 0.5,
        time + data.offset,
        1.0
      ) * data.turbulence

      const turbY = this._turbulence(
        streakPositions[idx] * 0.5 + 3,
        streakPositions[idx + 1] * 0.6 + 2,
        streakPositions[idx + 2] * 0.4 + 1,
        time * 0.6 + data.yOffset,
        0.8
      ) * data.turbulence * 0.6

      streakPositions[idx] += turbX * delta * 2
      streakPositions[idx + 1] += turbY * delta * 1.5
      streakPositions[idx + 2] += moveSpeed

      streakPositions[idx + 3] += turbX * delta * 2
      streakPositions[idx + 4] += turbY * delta * 1.5
      streakPositions[idx + 5] += moveSpeed

      if (streakPositions[idx + 5] > halfSize) {
        const overlap = streakPositions[idx + 5] - halfSize
        streakPositions[idx + 2] = -halfSize - data.len + overlap
        streakPositions[idx + 5] = -halfSize + overlap
        const newX = (Math.random() - 0.5) * halfSize * 2
        streakPositions[idx] = newX
        streakPositions[idx + 3] = newX
        const newY = Math.random() * 8 + 0.6
        streakPositions[idx + 1] = newY
        streakPositions[idx + 4] = newY
      }

      if (streakPositions[idx + 1] > 8.5 || streakPositions[idx + 1] < 0.4) {
        const newY = Math.random() * 7 + 0.8
        streakPositions[idx + 1] = newY
        streakPositions[idx + 4] = newY
      }
    }

    this.streaks.geometry.attributes.position.needsUpdate = true

    if (this.groundWind && this.groundWindData) {
      const gwPositions = this.groundWind.geometry.attributes.position.array
      const gwCount = this.groundWindData.length

      for (let i = 0; i < gwCount; i++) {
        const data = this.groundWindData[i]
        const idx = i * 6
        const moveSpeed = speed * data.speed * delta * 1.2

        const wobble = Math.sin(time * 2 + data.offset) * 0.05

        gwPositions[idx] += wobble
        gwPositions[idx + 3] += wobble
        gwPositions[idx + 2] += moveSpeed
        gwPositions[idx + 5] += moveSpeed

        if (gwPositions[idx + 5] > halfSize * 0.9) {
          const overlap = gwPositions[idx + 5] - halfSize * 0.9
          gwPositions[idx + 2] = -halfSize * 0.9 - data.len + overlap
          gwPositions[idx + 5] = -halfSize * 0.9 + overlap
          const newX = (Math.random() - 0.5) * halfSize * 1.7
          gwPositions[idx] = newX
          gwPositions[idx + 3] = newX
        }
      }

      this.groundWind.geometry.attributes.position.needsUpdate = true
    }

    if (this.windIndicator) {
      this.windIndicator.position.y = this.windIndicator.userData.baseY +
        Math.sin(time * 1.2) * 0.12 +
        Math.sin(time * 2.3) * 0.05
      this.windIndicator.rotation.z = Math.sin(time * 1.5) * 0.06 +
                                        Math.sin(time * 3.2) * 0.02

      const scale = 0.5 + this.windSpeed * 0.9
      this.windIndicator.scale.setScalar(scale)

      if (this.indicatorRing2) {
        this.indicatorRing2.rotation.z = time * 0.5
        const rs = 1 + Math.sin(time * 2) * 0.1
        this.indicatorRing2.scale.setScalar(rs)
      }
    }
  }

  addToScene(scene) {
    if (this.points) scene.add(this.points)
    if (this.streaks) scene.add(this.streaks)
    if (this.groundWind) scene.add(this.groundWind)
    if (this.windIndicator) scene.add(this.windIndicator)
  }
}
