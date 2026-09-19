import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export class SceneManager {
  constructor(container) {
    this.container = container
    this.scene = null
    this.camera = null
    this.renderer = null
    this.controls = null
    this.clock = new THREE.Clock()
    this.animatables = []
    this._init()
  }

  _init() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x8ba6b0)
    // 远景山在 z=-6 处，雾从 30 开始，到 85 完全雾化，既有空间感又能看到远山
    this.scene.fog = new THREE.Fog(0x8ba6b0, 30, 85)

    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.03, 1000)
    this.camera.position.set(12, 12, 12)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(width, height)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.maxPolarAngle = Math.PI / 2.2
    this.controls.minDistance = 3.5
    this.controls.maxDistance = 80
    this.controls.target.set(3.5, 0, 3.5)

    this._setupLights()
    this._setupSky()

    window.addEventListener('resize', () => this._onResize())

    this._animate()
  }

  _setupLights() {
    const ambient = new THREE.AmbientLight(0x404060, 0.4)
    this.scene.add(ambient)

    // 半球光：天空色 + 地面色，模拟自然环境光
    const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x3a7d44, 0.8)
    this.scene.add(hemiLight)

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(18, 28, 12)  // 更高更远，覆盖 24 单位地形
    dirLight.castShadow = true
    dirLight.shadow.mapSize.width = 2048
    dirLight.shadow.mapSize.height = 2048
    dirLight.shadow.camera.near = 0.5
    dirLight.shadow.camera.far = 80
    dirLight.shadow.camera.left = -18
    dirLight.shadow.camera.right = 18
    dirLight.shadow.camera.top = 18
    dirLight.shadow.camera.bottom = -18
    this.scene.add(dirLight)

    // 蓝色补光减弱，保留山体阴影和岩壁的真实对比
    const fillLight = new THREE.DirectionalLight(0x7da6b8, 0.12)
    fillLight.position.set(-5, 5, -5)
    this.scene.add(fillLight)
  }

  _setupSky() {
    const starsGeometry = new THREE.BufferGeometry()
    const starCount = 1000
    const positions = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount * 3; i += 3) {
      positions[i] = (Math.random() - 0.5) * 200
      positions[i + 1] = Math.random() * 100 + 20
      positions[i + 2] = (Math.random() - 0.5) * 200
    }
    starsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const starsMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.2,
      transparent: true,
      opacity: 0.8
    })
    const stars = new THREE.Points(starsGeometry, starsMaterial)
    this.scene.add(stars)
  }

  _onResize() {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  addAnimatable(fn) {
    this.animatables.push(fn)
  }

  _animate() {
    requestAnimationFrame(() => this._animate())
    const delta = this.clock.getDelta()
    this.controls.update()
    for (const fn of this.animatables) {
      // 单项出错只跳过这一项：否则后面的更新和 render 都不会执行，
      // 画面会卡住、语音时序也会跟着乱
      try {
        fn(delta)
      } catch (error) {
        console.error('场景动画项出错（已跳过，不影响本帧渲染）:', error)
      }
    }
    this.renderer.render(this.scene, this.camera)
  }

  add(object) {
    this.scene.add(object)
  }

  remove(object) {
    this.scene.remove(object)
  }
}
