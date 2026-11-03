import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'

/**
 * 本地文件与配置存储。这里不决定哪些路径可访问：用户路径必须先经过原生对话框，配置路径由主进程构造。
 */

/**
 * 用同目录临时文件替换目标文件，避免写入中断留下半份 JSON/文本。
 * @param {string} path 主进程已经授权的目标绝对路径。
 * @param {string|Buffer} data 完整内容；调用方负责大小、编码和内容校验。
 * @returns {Promise<void>} rename 成功后完成；这不等同于断电后的持久性保证。
 * @throws {Error} 创建目录、写入或替换失败；finally 尝试清理临时文件，原文件不会先被截断。
 */
export async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

/**
 * 只适用于小体量非敏感配置的 JSON 存储。patch 串行执行，落盘成功后才提交内存状态。
 * 凭据使用 Credentials 独立管理，不能借此保存明文令牌。
 */
export class JsonStore {
  #value
  #tail = Promise.resolve()
  /**
   * @param {string} path 配置绝对路径；构造时不读写磁盘。
   * @param {Object} defaults 首次运行或加载失败时保留的默认值，会复制为独立快照。
   * @param {Function} [validate] 同步校验器，返回允许保存的字段；同时用于加载和 patch。
   */
  constructor(path, defaults, validate = (value) => value) {
    this.path = path
    this.defaults = defaults
    this.validate = validate
    this.#value = structuredClone(defaults)
  }

  /**
   * 应用初始化时调用一次；文件不存在视为首次运行，不立即创建文件。
   * @returns {Promise<Object>} 默认值与合法文件字段浅合并后的副本。
   * @throws {AppError} 非 ENOENT 的读取/解析/校验失败归为 STORAGE_CORRUPT；失败不会覆盖原文件。
   */
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      this.#value = { ...this.defaults, ...this.validate(value) }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new AppError('STORAGE_CORRUPT', '本地设置无法读取，请检查配置文件后重试')
      }
    }
    return this.get()
  }

  /** @returns {Object} 独立深拷贝；调用方修改返回对象不会污染内存或磁盘。 */
  get() {
    return structuredClone(this.#value)
  }

  /**
   * 串行浅合并补丁。上一笔失败不会使后续队列永久拒绝。
   * @param {Object} patch 交给 validate 的补丁；校验器必须明确是否允许部分字段。
   * @returns {Promise<Object>} 成功落盘后的完整副本，UI 应以它更新显示状态。
   * @throws {Error} 校验或磁盘写入失败；内存仍保持上一份成功快照。
   */
  async patch(patch) {
    const safe = structuredClone(this.validate(patch))
    const task = this.#tail.then(async () => {
      const next = { ...this.#value, ...safe }
      await atomicWrite(this.path, JSON.stringify(next, null, 2))
      this.#value = next
      return this.get()
    })
    this.#tail = task.catch(() => {})
    return task
  }
}
