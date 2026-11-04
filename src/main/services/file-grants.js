import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { ensure, text } from '../../shared/validation.js'

// MAX_FILE：单文件的字节上限，固定 20MiB。
const MAX_FILE = 20 * 1024 * 1024

/**
 * 原生文件选择的授权表：renderer 接收 id/name/size，路径和文件身份只留在主进程。
 * owner 使用 webContents.id；授权不跨窗口、不持久化，也不能充当任意文件系统访问接口。
 *
 * 按窗口持有的不透明文件授权表，路径和文件身份只留在主进程，关闭窗口同时撤销等待中的申请。
 */
export class FileGrants {
  /** grants：已完成授权的 id 到文件身份映射。 */
  #grants = new Map()
  /** pending：尚在等待 stat 的预占申请集合，计入总名额限制。 */
  #pending = new Set()

  /**
   * @param {number} owner 发起原生选择的窗口 ID。
   * @param {string} path 选择器批准的绝对路径，禁止直接接受 renderer 传来的路径。
   * @returns {Promise<{id:string,name:string,size:number}>} size 单位为字节，最大 20 MiB。
   * @throws {AppError|Error} 超出 100 个并发/已完成授权、非普通文件、过大文件或上下文已关闭。
   *
   * 预占名额并读取文件身份，确认窗口仍有效后建立授权。
   */
  async add(owner, path) {
    ensure(this.#grants.size + this.#pending.size < 100, '已选文件过多，请先移除部分文件')
    // reservation：带窗口归属的申请占位，异步完成前可由 clear 撤销。
    const reservation = { owner }
    this.#pending.add(reservation)
    try {
      // info：同一文件在授权或读取开始时的 stat 身份快照。
      const info = await stat(path)
      ensure(this.#pending.has(reservation), '文件授权上下文已关闭', 'FILE_GRANT_EXPIRED')
      ensure(info.isFile() && info.size <= MAX_FILE, '仅支持 20 MiB 以内的普通文件')
      // id：授权时随机生成的不透明 ID，撤销时索引当前授权。
      const id = randomUUID()
      this.#grants.set(id, {
        owner,
        path,
        size: info.size,
        mtime: info.mtimeMs,
        ino: info.ino,
        dev: info.dev,
      })
      return { id, name: basename(path), size: info.size }
    } finally {
      this.#pending.delete(reservation)
    }
  }

  /**
   * 在实际读取时重新核对授权与文件身份，避免选择之后路径被替换或内容发生变化。
   * @param {number} owner 当前调用窗口 ID，必须与创建授权时一致。
   * @param {string} id 选择器返回的不透明授权 ID。
   * @param {number} [limit=20971520] 本次允许读取的字节数；文本预览使用更小的 1 MiB 上限。
   * @returns {Promise<{name:string,data:Buffer}>} 有界内容，不返回绝对路径；读取后仍需调用 release。
   * @throws {AppError|Error} 授权失效、文件替换/变化、超限或系统读取失败；句柄始终尝试关闭。
   *
   * 复验窗口归属、文件身份和大小，有界读取并在返回前再次核对授权。
   */
  async read(owner, id, limit = MAX_FILE) {
    text(id, 80)
    // grant：当前窗口持有的路径、大小、mtime、inode 和设备身份记录。
    const grant = this.#grants.get(id)
    ensure(grant?.owner === owner, '文件授权已失效，请重新选择', 'FILE_GRANT_EXPIRED')
    // handle：通过已授权路径打开的只读文件句柄，finally 关闭。
    const handle = await open(grant.path, 'r')
    try {
      // info：同一文件在授权或读取开始时的 stat 身份快照。
      const info = await handle.stat()
      ensure(
        info.isFile() &&
          info.size === grant.size &&
          info.mtimeMs === grant.mtime &&
          info.ino === grant.ino &&
          info.dev === grant.dev,
        '文件已变化，请重新选择',
        'FILE_CHANGED',
      )
      ensure(info.size <= limit, `文件超过 ${Math.floor(limit / 1024)} KiB 限制`)
      // 多读一个字节，防止 stat 后文件增长造成无限读取。
      // buffer：原大小加一字节的有界读取缓冲，用于发现读取中增长。
      const buffer = Buffer.alloc(info.size + 1)
      // length：实际已读字节数，必须与授权大小相同。
      let length = 0
      while (length < buffer.length) {
        // bytesRead：本轮读取的字节数，为零表示 EOF。
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== info.size) throw new AppError('FILE_CHANGED', '文件已变化，请重新选择')
      // after：读取完成后再次取得的文件状态，验证内容期间没有变化。
      const after = await handle.stat()
      ensure(
        after.size === info.size && after.mtimeMs === info.mtimeMs,
        '文件已变化，请重新选择',
        'FILE_CHANGED',
      )
      ensure(this.#grants.get(id) === grant, '文件授权已失效', 'FILE_GRANT_EXPIRED')
      return { name: basename(grant.path), data: buffer.subarray(0, length) }
    } finally {
      await handle.close()
    }
  }

  /**
   * @param {number} owner 授权归属窗口。
   * @param {string} id 要撤销的授权；不存在或属于其他窗口时不处理，可重复调用。
   * @returns {void} 不删除用户文件，只撤销内存中的读取能力。
   *
   * 幂等撤销属于当前窗口的单个授权，不删除用户文件。
   */
  release(owner, id) {
    if (this.#grants.get(id)?.owner === owner) this.#grants.delete(id)
  }

  /**
   * 窗口销毁时撤销已完成授权及正在等待 stat 的申请，迟到申请不能重新加入授权表。
   * @param {number} owner 已关闭窗口的 ID；不影响其他窗口。
   * @returns {void} 已发出的读取也会在返回内容前再次确认授权是否仍有效。
   *
   * 撤销窗口已完成及等待中的所有授权申请。
   */
  clear(owner) {
    // reservation：带窗口归属的申请占位，异步完成前可由 clear 撤销。
    for (const reservation of this.#pending)
      if (reservation.owner === owner) this.#pending.delete(reservation)
    // id：授权时随机生成的不透明 ID，撤销时索引当前授权。
    // grant：当前窗口持有的路径、大小、mtime、inode 和设备身份记录。
    for (const [id, grant] of this.#grants) {
      if (grant.owner === owner) this.#grants.delete(id)
    }
  }
}
