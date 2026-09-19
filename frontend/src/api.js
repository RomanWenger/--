import axios from 'axios'

// 开发时走 Vite proxy(/api → :5000)，打包后直连 Flask
const API_BASE = window.location.protocol === 'file:' || window.location.port === ''
  ? 'http://127.0.0.1:5000/api'
  : '/api'

/**
 * 统一请求封装：任何非 2xx 响应都抛出带服务端详情的错误，
 * 前端不再只能看到笼统的"失败"，而能在 err.message 里看到真实原因。
 */
async function request(config) {
  try {
    const res = await axios({ ...config, validateStatus: s => s < 300 })
    return res.data
  } catch (err) {
    if (err.response) {
      const body = err.response.data
      const msg = body && (body.detail || body.error)
        ? `${body.detail || body.error}`
        : `HTTP ${err.response.status} ${err.response.statusText}`
      throw new Error(msg)
    }
    throw new Error(err.message || String(err))
  }
}

export async function getTerrain(amplitude = 1.0) {
  return request({ url: `${API_BASE}/terrain`, params: { amplitude } })
}

export async function getPath(windSpeed = 0.5, amplitude = 1.0, episode = 200) {
  return request({
    url: `${API_BASE}/path`,
    method: 'POST',
    data: { wind_speed: windSpeed, amplitude, episode }
  })
}

export async function getTrainingStages() {
  return request({ url: `${API_BASE}/training-stages` })
}

export async function getLearningCurve() {
  return request({ url: `${API_BASE}/learning-curve` })
}

export async function checkHealth() {
  try {
    return await request({ url: `${API_BASE}/health` })
  } catch (e) {
    return { status: 'error', environment_ready: false, agent_ready: false, message: e.message }
  }
}

export async function getHazard(intensity = 0.5) {
  return request({ url: `${API_BASE}/hazard`, params: { intensity } })
}

export async function trainModel(episodes = 200, windSpeed = 0.5) {
  return request({
    url: `${API_BASE}/train`,
    method: 'POST',
    data: { episodes, wind_speed: windSpeed }
  })
}

export async function startTraining(episodes = 200, windSpeed = 0.5) {
  return request({
    url: `${API_BASE}/train/start`,
    method: 'POST',
    data: { episodes, wind_speed: windSpeed }
  })
}

export async function getTrainingProgress(taskId) {
  return request({ url: `${API_BASE}/train/progress/${encodeURIComponent(taskId)}` })
}

export async function stopTraining(taskId) {
  return request({
    url: `${API_BASE}/train/stop/${encodeURIComponent(taskId)}`,
    method: 'POST'
  })
}

export async function getTrainingHistory(limit = 200) {
  return request({ url: `${API_BASE}/training-history`, params: { limit } })
}

export async function getTrainingSnapshot(episode = 0) {
  return request({ url: `${API_BASE}/training-snapshot`, params: { episode } })
}

export async function getTrainingSnapshots() {
  return request({ url: `${API_BASE}/training-snapshots` })
}