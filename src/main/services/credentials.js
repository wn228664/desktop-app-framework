import { readFile, rm } from 'node:fs/promises'
import { AppError } from '../../shared/errors.js'
import { text } from '../../shared/validation.js'
import { atomicWrite } from './storage.js'

/**
 * 主进程专用的访问令牌容器。默认仅存内存，remember=true 才调用系统加密后落盘。
 * renderer 只有设置/清除能力，没有读取令牌的 IPC；请求服务在发送时读取内存值。
 *
 * 仅主进程拥有的令牌容器，内存默认、显式系统加密持久化；凭据更新队列期间禁止读取旧身份。
 */
export class Credentials {
  /** token：当前最后成功提交的内存令牌，初始空串。 */
  #token = ''
  /** tail：串行凭据修改队列，失败被尾部消费以允许后续重试。 */
  #tail = Promise.resolve()
  /** pending：已排队尚未结算的修改数，大于零时 token getter 拒绝读取。 */
  #pending = 0
  /**
   * @param {string} path 密文文件绝对路径，不能与普通偏好文件复用。
   * @param {Object} crypto Electron safeStorage 异步接口，测试可注入不访问真实钥匙串的实现。
   *
   * 保存密文路径和系统加密适配器，构造时不读磁盘。
   */
  constructor(path, crypto) {
    // this.path：仅主进程构造的密文文件路径。
    this.path = path
    // this.crypto：可注入的系统加密适配器，不降级为明文持久化。
    this.crypto = crypto
  }

  /**
   * 仅供主进程请求服务使用，不允许经 info、日志或状态管理器转发。
   * @returns {string} 当前令牌，未设置时为空串。
   * @throws {AppError} 写队列未完成时为 BUSY，避免新请求混用切换前后的凭据。
   *
   * 无凭据修改等待时读取主进程内存令牌。
   */
  get token() {
    if (this.#pending) throw new AppError('BUSY', '访问凭据正在更新，请稍后重试')
    return this.#token
  }

  /**
   * 启动阶段恢复密文；密钥轮换时用当前密钥重新加密，不降级为明文文件。
   * @returns {Promise<void>} 没有文件时保持空令牌。
   * @throws {AppError} 解密/重新加密失败归为 CREDENTIAL_UNAVAILABLE，由 UI 提示重新设置。
   *
   * 启动时恢复密文，必要时重新加密；异常不返回旧明文。
   */
  async load() {
    try {
      // encrypted：从磁盘读取的系统密文。
      const encrypted = await readFile(this.path)
      // result：系统解密后的令牌，仅用于校验和主进程内存提交。
      // shouldReEncrypt：系统密钥轮换标记，为 true 时以当前密钥重新加密落盘。
      const { result, shouldReEncrypt } = await this.crypto.decryptStringAsync(encrypted)
      text(result, 8192)
      if (shouldReEncrypt)
        await atomicWrite(this.path, await this.crypto.encryptStringAsync(result))
      this.#token = result
    } catch (error) {
      // error：当前捕获的异常；跨 IPC 只交付 publicError 的公开字段。

      if (error.code !== 'ENOENT') {
        throw new AppError('CREDENTIAL_UNAVAILABLE', '系统凭据暂不可用，请重新设置访问令牌')
      }
    }
  }

  /**
   * @param {string} token 最多 8192 个字符；空串表示清除。
   * @param {boolean} [remember=false] false 会移除旧密文，防止下次启动恢复过期令牌。
   * @returns {Promise<void>} 系统加密与文件操作完成后才替换内存令牌；多次调用按到达顺序执行。
   * @throws {AppError|Error} 系统加密不可用或磁盘失败；失败保留原成功状态，不输出令牌内容。
   *
   * 校验输入并排队凭据设置或清除。
   */
  set(token, remember = false) {
    text(token, 8192, true)
    this.#pending++
    // task：本笔串行修改，磁盘成功后才替换内存令牌。
    const task = this.#tail.then(
      /**
       * 执行系统加密/删除旧密文，再提交新内存值。
       */
      async () => {
        if (token && remember) {
          if (!(await this.crypto.isAsyncEncryptionAvailable())) {
            throw new AppError('ENCRYPTION_UNAVAILABLE', '系统加密不可用，未保存访问令牌')
          }
          await atomicWrite(this.path, await this.crypto.encryptStringAsync(token))
        } else await rm(this.path, { force: true })
        this.#token = token
      },
    )
    // settled：包含 pending 计数归还的本笔结果 Promise。
    const settled = task.finally(
      /**
       * 本笔修改无论成败都归还 pending 计数。
       */
      () => {
        this.#pending--
      },
    )
    this.#tail = settled.catch(
      /**
       * 只恢复后续队列可执行性，不改变本笔调用的失败。
       */
      () => {},
    )
    return settled
  }
}
