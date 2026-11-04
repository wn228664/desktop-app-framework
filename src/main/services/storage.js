import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'

/**
 * 本地文件与配置存储。这里不决定哪些路径可访问：用户路径必须先经过原生对话框，配置路径由主进程构造。
 *
 * 用同目录临时文件替换目标文件，避免写入中断留下半份 JSON/文本。
 * @param {string} path 主进程已经授权的目标绝对路径。
 * @param {string|Buffer} data 完整内容；调用方负责大小、编码和内容校验。
 * @returns {Promise<void>} rename 成功后完成；这不等同于断电后的持久性保证。
 * @throws {Error} 创建目录、写入或替换失败；finally 尝试清理临时文件，原文件不会先被截断。
 *
 * 原子替换完整内容，finally 尝试清理临时文件。
 */
export async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true })
  // temp：目标同目录随机临时文件，独占创建后以 rename 替换。
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
 *
 * 小体量非敏感 JSON 配置，修改串行执行，校验和落盘成功后才替换内存快照。
 */
export class JsonStore {
  /** value：最后一份成功提交的配置快照，不能直接暴露其引用。 */
  #value
  /** tail：序列化 patch 的队列尾部，拒绝不阻塞后续修改。 */
  #tail = Promise.resolve()
  /**
   * @param {string} path 配置绝对路径；构造时不读写磁盘。
   * @param {Object} defaults 首次运行或加载失败时保留的默认值，会复制为独立快照。
   * @param {Function} [validate] 同步校验器，返回允许保存的字段；同时用于加载和 patch。
   *
   * 保存路径和校验器，建立默认值独立快照。
   */
  constructor(
    path,
    defaults,

    /**
     * 缺省校验器保持输入值，不提供额外 schema 限制。
     * value：缺省校验器收到的配置值，原样交还；接入方应提供具体字段校验。
     */
    validate = (value) => value,
  ) {
    // this.path：仅主进程选择的配置文件绝对路径。
    this.path = path
    // this.defaults：加载缺失或失败时的默认配置来源。
    this.defaults = defaults
    // this.validate：加载和修改共同使用的同步字段校验器。
    this.validate = validate
    this.#value = structuredClone(defaults)
  }

  /**
   * 应用初始化时调用一次；文件不存在视为首次运行，不立即创建文件。
   * @returns {Promise<Object>} 默认值与合法文件字段浅合并后的副本。
   * @throws {AppError} 非 ENOENT 的读取/解析/校验失败归为 STORAGE_CORRUPT；失败不会覆盖原文件。
   *
   * 加载存在的合法配置；损坏明确拒绝并保留原文件。
   */
  async load() {
    try {
      // value：磁盘解析出的配置值，验证后才能进入内存。
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      this.#value = { ...this.defaults, ...this.validate(value) }
    } catch (error) {
      // error：当前捕获的异常；跨 IPC 只交付 publicError 的公开字段。

      if (error.code !== 'ENOENT') {
        throw new AppError('STORAGE_CORRUPT', '本地设置无法读取，请检查配置文件后重试')
      }
    }
    return this.get()
  }

  /**
   * 返回内存配置的独立深拷贝。
   */
  get() {
    return structuredClone(this.#value)
  }

  /**
   * 串行浅合并补丁。上一笔失败不会使后续队列永久拒绝。
   * @param {Object} patch 交给 validate 的补丁；校验器必须明确是否允许部分字段。
   * @returns {Promise<Object>} 成功落盘后的完整副本，UI 应以它更新显示状态。
   * @throws {Error} 校验或磁盘写入失败；内存仍保持上一份成功快照。
   *
   * 校验并复制补丁，再排队落盘。
   */
  async patch(patch) {
    // safe：经校验并复制的补丁，不受调用者随后修改影响。
    const safe = structuredClone(this.validate(patch))
    // task：本笔配置写入的结果 Promise，失败保持原内存状态。
    const task = this.#tail.then(
      /**
       * 基于最新成功内存状态写磁盘，成功后才提交内存。
       */
      async () => {
        // next：将本笔补丁合并到上笔成功状态的候选快照。
        const next = { ...this.#value, ...safe }
        await atomicWrite(this.path, JSON.stringify(next, null, 2))
        this.#value = next
        return this.get()
      },
    )
    this.#tail = task.catch(
      /**
       * 恢复队列可执行性，本笔失败仍由 task 向外报告。
       */
      () => {},
    )
    return task
  }
}
