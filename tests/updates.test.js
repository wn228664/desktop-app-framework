import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Updates } from '../src/main/services/updates.js'

/**
 * 验证：未配置/开发模式不伪造更新结果，不自动下载或退出安装。
 */
test('未配置/开发模式不伪造更新结果，不自动下载或退出安装', async () => {
  // updater：仅供当前用例使用的更新器事件/行为替身。
  const updater = new EventEmitter()
  // updates：绑定当前更新器替身的用户驱动更新状态机。
  const updates = new Updates(
    updater,
    '',
    false,
    /**
     * 无配置用例不额外观察状态。
     */
    () => {},
  )
  assert.equal(updates.state.status, 'unconfigured')
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  await assert.rejects(updates.run('check'), { code: 'NOT_CONFIGURED' })
})

/**
 * 验证：更新只允许显式检查、可用后下载、已下载后安装，错误公开化。
 */
test('更新只允许显式检查、可用后下载、已下载后安装，错误公开化', async () => {
  // updater：仅供当前用例使用的更新器事件/行为替身。
  const updater = new EventEmitter()
  // release：更新检查受控等待的完成入口。
  let release
  // installed：安装替身是否执行，默认 false，检查/下载不得提前安装。
  let installed = false
  updater.setFeedURL =
    /**
     * 占位 feed 设置接口，不覆盖真实 builder 元数据链。
     */
    () => {}
  updater.checkForUpdates =
    /**
     * 模拟检查开始并等待用例完成后宣布新版本可用。
     */
    async () => {
      updater.emit('checking-for-update')
      await new Promise(
        /**
         * 保留检查完成入口以制造稳定的互斥窗口。
         * resolve：受控等待的成功入口，由本用例主动结算。
         */
        (resolve) => {
          release = resolve
        },
      )
      updater.emit('update-available', { version: '1.0.1' })
    }
  updater.downloadUpdate =
    /**
     * 依次模拟真实下载进度和下载完成事件。
     */
    async () => {
      updater.emit('download-progress', { percent: 50 })
      updater.emit('update-downloaded', { version: '1.0.1' })
    }
  updater.quitAndInstall =
    /**
     * 标记安装动作执行，不真的退出系统程序。
     */
    () => {
      installed = true
    }
  // states：向观察者发布的更新公开状态序列。
  const states = []
  // updates：绑定当前更新器替身的用户驱动更新状态机。
  const updates = new Updates(
    updater,
    'https://example.com/releases/',
    true,
    /**
     * 收集更新器投影的公开状态。
     * state：本用例收到的公开状态快照。
     */
    (state) => states.push(state),
  )
  await assert.rejects(updates.run('install'), { code: 'INVALID_STATE' })
  // checking：正在等待的检查动作 Promise，用于验证 BUSY。
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
    states.some(
      /**
       * 查找预期 50% 下载进度是否到达观察者。
       * state：本用例收到的公开状态快照。
       */
      (state) => state.percent === 50,
    ),
    true,
  )
})
