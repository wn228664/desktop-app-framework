import { AppError } from '../../shared/errors.js'

/**
 * 用户驱动的更新状态机：检查 → 可下载 → 下载完成 → 确认安装。
 * 不自动下载、不在普通退出时安装、不接收预发布版本。真实签名与 provider 配置由 builder 生成。
 */
export class Updates {
  #busy = false
  /**
   * @param {Object} updater electron-updater 实例；应用级只创建一个，事件监听与进程同寿命。
   * @param {string} url 构建配置中的更新基址，仅用于判断能力是否已配置，不替换包内 feed。
   * @param {boolean} packaged 开发/预览模式为 false，避免对未签名开发程序执行升级。
   * @param {Function} notify 接收已脱敏状态；错误不转发底层下载地址、文件路径或堆栈。
   */
  constructor(updater, url, packaged, notify) {
    this.updater = updater
    this.enabled = Boolean(url && packaged)
    this.state = { status: this.enabled ? 'idle' : 'unconfigured' }
    this.notify = notify
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    // 使用 builder 生成的 app-update.yml，保留 Windows publisherName 签名验证。
    // 单独 setFeedURL 会在元数据缺失时绕过这条校验链。
    const states = {
      'checking-for-update': () => ({ status: 'checking' }),
      'update-available': (info) => ({ status: 'available', version: info.version }),
      'update-not-available': () => ({ status: 'current' }),
      'download-progress': (info) => ({ status: 'downloading', percent: info.percent }),
      'update-downloaded': (info) => ({ status: 'downloaded', version: info.version }),
      error: () => ({ status: 'failed', message: '更新失败，请检查网络、发布配置与签名' }),
    }
    for (const [event, transform] of Object.entries(states)) {
      updater.on(event, (info) => {
        this.state = transform(info)
        notify(this.state)
      })
    }
  }

  /**
   * @param {'check'|'download'|'install'} action 用户明确选择的动作；install 前应由 UI 二次确认。
   * @returns {Promise<Object>} 当前状态快照；事件可能在 Promise 完成前推送，UI 不应用旧快照覆盖新事件。
   * @throws {AppError|Error} 未配置、操作互斥、非法状态或 updater 失败。不能跳过 available 直接下载。
   * install 会触发退出/重启，调用方不应把 Promise 返回当成升级链路已经验收成功。
   */
  async run(action) {
    if (!this.enabled) throw new AppError('NOT_CONFIGURED', '请在正式安装包中配置更新地址后使用')
    if (this.#busy) throw new AppError('BUSY', '更新操作正在进行')
    this.#busy = true
    try {
      if (action === 'check') await this.updater.checkForUpdates()
      else if (action === 'download' && this.state.status === 'available') {
        await this.updater.downloadUpdate()
      } else if (action === 'install' && this.state.status === 'downloaded') {
        this.updater.quitAndInstall()
      } else throw new AppError('INVALID_STATE', '当前状态不支持此操作')
      return this.state
    } finally {
      this.#busy = false
    }
  }
}
