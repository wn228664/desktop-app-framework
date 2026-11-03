import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Updates } from '../src/main/services/updates.js'

/** 用受控事件验证更新状态和显式安装门禁；真实发布服务、签名与重启安装由平台验收覆盖。 */
test('未配置/开发模式不伪造更新结果，不自动下载或退出安装', async () => {
  const updater = new EventEmitter()
  const updates = new Updates(updater, '', false, () => {})
  assert.equal(updates.state.status, 'unconfigured')
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  await assert.rejects(updates.run('check'), { code: 'NOT_CONFIGURED' })
})

test('更新只允许显式检查、可用后下载、已下载后安装，错误公开化', async () => {
  const updater = new EventEmitter()
  let release
  let installed = false
  updater.setFeedURL = () => {}
  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update')
    await new Promise((resolve) => {
      release = resolve
    })
    updater.emit('update-available', { version: '1.0.1' })
  }
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 50 })
    updater.emit('update-downloaded', { version: '1.0.1' })
  }
  updater.quitAndInstall = () => {
    installed = true
  }
  const states = []
  const updates = new Updates(updater, 'https://example.com/releases/', true, (state) =>
    states.push(state),
  )
  await assert.rejects(updates.run('install'), { code: 'INVALID_STATE' })
  const checking = updates.run('check')
  await assert.rejects(updates.run('check'), { code: 'BUSY' })
  release()
  await checking
  assert.equal(updates.state.status, 'available')
  await updates.run('download')
  assert.equal(installed, false)
  await updates.run('install')
  assert.equal(installed, true)
  updater.emit('error', new Error('private update path'))
  assert.equal(updates.state.status, 'failed')
  assert.equal(updates.state.message.includes('private'), false)
  assert.equal(
    states.some((state) => state.percent === 50),
    true,
  )
})
