import { readFile, rm } from 'node:fs/promises'
import { AppError } from '../../shared/errors.js'
import { text } from '../../shared/validation.js'
import { atomicWrite } from './storage.js'

/**
 * 主进程专用的访问令牌容器。默认仅存内存，remember=true 才调用系统加密后落盘。
 * renderer 只有设置/清除能力，没有读取令牌的 IPC；请求服务在发送时读取内存值。
 */
export class Credentials {
  #token = ''
  #tail = Promise.resolve()
  #pending = 0
  /**
   * @param {string} path 密文文件绝对路径，不能与普通偏好文件复用。
   * @param {Object} crypto Electron safeStorage 异步接口，测试可注入不访问真实钥匙串的实现。
   */
  constructor(path, crypto) {
    this.path = path
    this.crypto = crypto
  }

  /**
   * 仅供主进程请求服务使用，不允许经 info、日志或状态管理器转发。
   * @returns {string} 当前令牌，未设置时为空串。
   * @throws {AppError} 写队列未完成时为 BUSY，避免新请求混用切换前后的凭据。
   */
  get token() {
    if (this.#pending) throw new AppError('BUSY', '访问凭据正在更新，请稍后重试')
    return this.#token
  }

  /**
   * 启动阶段恢复密文；密钥轮换时用当前密钥重新加密，不降级为明文文件。
   * @returns {Promise<void>} 没有文件时保持空令牌。
   * @throws {AppError} 解密/重新加密失败归为 CREDENTIAL_UNAVAILABLE，由 UI 提示重新设置。
   */
  async load() {
    try {
      const encrypted = await readFile(this.path)
      const { result, shouldReEncrypt } = await this.crypto.decryptStringAsync(encrypted)
      text(result, 8192)
      if (shouldReEncrypt)
        await atomicWrite(this.path, await this.crypto.encryptStringAsync(result))
      this.#token = result
    } catch (error) {
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
   */
  set(token, remember = false) {
    text(token, 8192, true)
    this.#pending++
    const task = this.#tail.then(async () => {
      if (token && remember) {
        if (!(await this.crypto.isAsyncEncryptionAvailable())) {
          throw new AppError('ENCRYPTION_UNAVAILABLE', '系统加密不可用，未保存访问令牌')
        }
        await atomicWrite(this.path, await this.crypto.encryptStringAsync(token))
      } else await rm(this.path, { force: true })
      this.#token = token
    })
    const settled = task.finally(() => {
      this.#pending--
    })
    this.#tail = settled.catch(() => {})
    return settled
  }
}
