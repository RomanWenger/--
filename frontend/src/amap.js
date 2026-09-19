// 高德地图集成模块 - 展示吉隆口岸真实地理位置
// 将仿真场景与真实地理环境关联，增强科普的真实感

const AMAP_KEY = '55234cfa9afe6ea5724542343ba94b31'
const AMAP_SECURITY = '68999fbd95578f721f07833e4674ae58'

// 吉隆口岸·热索桥受灾区（中尼边境，南端深切峡谷交汇口）
const JILONG_PORT = {
  lng: 85.378,
  lat: 28.267,
  name: '吉隆口岸·热索桥 (泥石流受灾点)',
  description: '东林藏布河谷口岸核心区，泥石流堆积严重，道路通信中断'
}

// 起点：吉隆镇救援指挥所（北侧安全台地，海拔约2800m，距口岸约24km）
const START_POINT = {
  lng: 85.298,
  lat: 28.397,
  name: '吉隆救援指挥所 (吉隆镇安全集结区)',
  description: '后方救援指挥中心与装备集结基地，沿 G216 向南口岸挺进'
}

// 终点：吉隆口岸·热索桥（南端河谷受灾区）
const END_POINT = {
  lng: 85.378,
  lat: 28.267,
  name: '吉隆口岸·热索桥受灾区',
  description: '中尼边境一类陆路口岸，受特大泥石流直接冲击'
}

let mapInstance = null
let scriptLoaded = false

export function loadAmapScript() {
  return new Promise((resolve, reject) => {
    if (scriptLoaded) {
      resolve()
      return
    }

    // 设置安全密钥
    window._AMapSecurityConfig = {
      securityJsCode: AMAP_SECURITY
    }

    const existingScript = document.getElementById('amap-sdk')
    if (existingScript) {
      if (window.AMap) {
        scriptLoaded = true
        resolve()
      } else {
        existingScript.onload = () => {
          scriptLoaded = true
          resolve()
        }
        existingScript.onerror = reject
      }
      return
    }

    const script = document.createElement('script')
    script.id = 'amap-sdk'
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}&plugin=AMap.Scale,AMap.ToolBar,AMap.Marker,AMap.Polyline,AMap.InfoWindow`
    script.onload = () => {
      scriptLoaded = true
      resolve()
    }
    script.onerror = reject
    document.head.appendChild(script)
  })
}

export async function initAmap(containerId) {
  await loadAmapScript()

  const container = document.getElementById(containerId)
  if (!container) return null

  // 创建地图子容器，避免覆盖 overlay 和关闭按钮
  let mapDiv = document.getElementById('amap-map-div')
  if (!mapDiv) {
    mapDiv = document.createElement('div')
    mapDiv.id = 'amap-map-div'
    mapDiv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;'
    container.insertBefore(mapDiv, container.firstChild)
  }

  if (mapInstance) {
    mapInstance.destroy()
  }

  mapInstance = new AMap.Map(mapDiv, {
    zoom: 13,
    center: [JILONG_PORT.lng, JILONG_PORT.lat],
    viewMode: '3D',
    pitch: 45,
    mapStyle: 'amap://styles/dark',
    features: ['bg', 'road', 'building', 'point']
  })

  // 添加比例尺
  mapInstance.addControl(new AMap.Scale())
  mapInstance.addControl(new AMap.ToolBar({ position: 'RB' }))

  // 起点标记
  const startMarker = new AMap.Marker({
    position: [START_POINT.lng, START_POINT.lat],
    icon: new AMap.Icon({
      size: new AMap.Size(32, 32),
      image: 'https://webapi.amap.com/theme/v1.3/markers/n/start.png',
      imageSize: new AMap.Size(32, 32)
    }),
    offset: new AMap.Pixel(-16, -32),
    title: START_POINT.name
  })

  const startInfo = new AMap.InfoWindow({
    content: `<div style="padding:8px;min-width:140px;">
      <div style="font-weight:bold;color:#22c55e;font-size:14px;">🟢 ${START_POINT.name}</div>
      <div style="color:#94a3b8;font-size:12px;margin-top:4px;">${START_POINT.description}</div>
    </div>`,
    offset: new AMap.Pixel(0, -32)
  })

  startMarker.on('click', () => {
    startInfo.open(mapInstance, startMarker.getPosition())
  })
  mapInstance.add(startMarker)

  // 终点标记
  const endMarker = new AMap.Marker({
    position: [END_POINT.lng, END_POINT.lat],
    icon: new AMap.Icon({
      size: new AMap.Size(32, 32),
      image: 'https://webapi.amap.com/theme/v1.3/markers/n/end.png',
      imageSize: new AMap.Size(32, 32)
    }),
    offset: new AMap.Pixel(-16, -32),
    title: END_POINT.name
  })

  const endInfo = new AMap.InfoWindow({
    content: `<div style="padding:8px;min-width:140px;">
      <div style="font-weight:bold;color:#ef4444;font-size:14px;">🔴 ${END_POINT.name}</div>
      <div style="color:#94a3b8;font-size:12px;margin-top:4px;">${END_POINT.description}</div>
    </div>`,
    offset: new AMap.Pixel(0, -32)
  })

  endMarker.on('click', () => {
    endInfo.open(mapInstance, endMarker.getPosition())
  })
  mapInstance.add(endMarker)

  // 吉隆口岸标注
  const portMarker = new AMap.Marker({
    position: [JILONG_PORT.lng, JILONG_PORT.lat],
    icon: new AMap.Icon({
      size: new AMap.Size(32, 32),
      image: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
      imageSize: new AMap.Size(32, 32)
    }),
    offset: new AMap.Pixel(-16, -32),
    title: JILONG_PORT.name
  })

  const portInfo = new AMap.InfoWindow({
    content: `<div style="padding:10px;min-width:180px;">
      <div style="font-weight:bold;color:#38bdf8;font-size:15px;">📍 ${JILONG_PORT.name}</div>
      <div style="color:#cbd5e1;font-size:12px;margin-top:6px;line-height:1.6;">${JILONG_PORT.description}</div>
      <div style="color:#64748b;font-size:11px;margin-top:6px;">经度: ${JILONG_PORT.lng}°E<br>纬度: ${JILONG_PORT.lat}°N</div>
    </div>`,
    offset: new AMap.Pixel(0, -32)
  })

  portMarker.on('click', () => {
    portInfo.open(mapInstance, portMarker.getPosition())
  })
  mapInstance.add(portMarker)

  // 自动打开口岸信息
  setTimeout(() => {
    portInfo.open(mapInstance, portMarker.getPosition())
  }, 800)

  // 绘制救援路径（沿 G216 河谷通道向南挺进）
  const pathCoords = [
    [START_POINT.lng, START_POINT.lat],   // 吉隆镇 (北)
    [85.312, 28.365],
    [85.334, 28.330],
    [85.355, 28.298],
    [JILONG_PORT.lng, JILONG_PORT.lat],    // 吉隆口岸·热索桥 (南)
    [END_POINT.lng, END_POINT.lat]
  ]

  const polyline = new AMap.Polyline({
    path: pathCoords,
    strokeColor: '#fbbf24',
    strokeWeight: 4,
    strokeOpacity: 0.8,
    strokeStyle: 'solid',
    lineJoin: 'round',
    showDir: true
  })
  mapInstance.add(polyline)

  // 自动适配视野，完整展示吉隆镇 → 热索桥全程救援动线
  mapInstance.setFitView([startMarker, endMarker, portMarker], false, [60, 60, 60, 60])

  return mapInstance
}

export function destroyAmap() {
  if (mapInstance) {
    mapInstance.destroy()
    mapInstance = null
  }
}

export function getAmapInstance() {
  return mapInstance
}
