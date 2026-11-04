import { AppError } from '../../shared/errors.js'

/**
 * 用户驱动的更新状态机：检查 → 可下载 → 下载完成 → 确认安装。
 * 不自动下载、不在普通退出时安装、不接收预发布版本。真实签名与 provider 配置由 builder 生成。
 *
 * 仅由用户驱动的签名更新状态机，开发模式禁用，检查、下载与安装必须按状态推进。
 */
export class Updates {
  /** busy：当前是否正在执行一次更新动作，finally 释放。 */
  #busy = false
  /**
   * @param {Object} updater electron-updater 实例；应用级只创建一个，事件监听与进程同寿命。
   * @param {string} url 构建配置中的更新基址，仅用于判断能力是否已配置，不替换包内 feed。
   * @param {boolean} packaged 开发/预览模式为 false，避免对未签名开发程序执行升级。
   * @param {Function} notify 接收已脱敏状态；错误不转发底层下载地址、文件路径或堆栈。
   *
   * 关闭自动下载和退出安装，安装脱敏的应用级事件监听。
   */
  constructor(updater, url, packaged, notify) {
    // this.updater：应用级 electron-updater 实例，保留 builder 生成的签名校验配置。
    this.updater = updater
    // this.enabled：只有配置更新基址且为正式安装包才可用。
    this.enabled = Boolean(url && packaged)
    // this.state：当前公开更新状态，不含底层下载路径或堆栈。
    this.state = { status: this.enabled ? 'idle' : 'unconfigured' }
    // this.notify：公开状态变化观察器。
    this.notify = notify
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    // 使用 builder 生成的 app-update.yml，保留 Windows publisherName 签名验证。
    // 单独 setFeedURL 会在元数据缺失时绕过这条校验链。
    // states：updater 事件名到公开状态投影函数的映射。
    const states = {
      /**
       * 将开始检查事件投影为 checking。
       */
      'checking-for-update': () => ({ status: 'checking' }),
      /**
       * 仅提取可用更新的版本号。
       * info：updater 的事件数据，只投影版本或百分比，不转发完整对象。
       */
      'update-available': (info) => ({ status: 'available', version: info.version }),
      /**
       * 将无更新事件投影为 current。
       */
      'update-not-available': () => ({ status: 'current' }),
      /**
       * 仅提取下载进度百分比。
       * info：updater 的事件数据，只投影版本或百分比，不转发完整对象。
       */
      'download-progress': (info) => ({ status: 'downloading', percent: info.percent }),
      /**
       * 仅提取已下载更新的版本号。
       * info：updater 的事件数据，只投影版本或百分比，不转发完整对象。
       */
      'update-downloaded': (info) => ({ status: 'downloaded', version: info.version }),
      /**
       * 将所有底层更新错误投影为固定公开失败说明。
       */
      error: () => ({ status: 'failed', message: '更新失败，请检查网络、发布配置与签名' }),
    }
    // event：当前安装监听的更新事件名。
    // transform：仅提取对应事件公开字段的投影函数。
    for (const [event, transform] of Object.entries(states)) {
      updater.on(
        event,
        /**
         * 投影上游事件并提交/通知新的公开状态。
         * info：updater 的事件数据，只投影版本或百分比，不转发完整对象。
         */
        (info) => {
          this.state = transform(info)
          notify(this.state)
        },
      )
    }
  }

  /**
   * @param {'check'|'download'|'install'} action 用户明确选择的动作；install 前应由 UI 二次确认。
   * @returns {Promise<Object>} 当前状态快照；事件可能在 Promise 完成前推送，UI 不应用旧快照覆盖新事件。
   * @throws {AppError|Error} 未配置、操作互斥、非法状态或 updater 失败。不能跳过 available 直接下载。
   * install 会触发退出/重启，调用方不应把 Promise 返回当成升级链路已经验收成功。
   *
   * 按已配置能力、互斥和当前状态执行用户明确的动作。
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
