import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { ensure, text } from '../../shared/validation.js'

const MAX_FILE = 20 * 1024 * 1024

/**
 * 原生文件选择的授权表：renderer 接收 id/name/size，路径和文件身份只留在主进程。
 * owner 使用 webContents.id；授权不跨窗口、不持久化，也不能充当任意文件系统访问接口。
 */
export class FileGrants {
  #grants = new Map()
  #pending = new Set()

  /**
   * @param {number} owner 发起原生选择的窗口 ID。
   * @param {string} path 选择器批准的绝对路径，禁止直接接受 renderer 传来的路径。
   * @returns {Promise<{id:string,name:string,size:number}>} size 单位为字节，最大 20 MiB。
   * @throws {AppError|Error} 超出 100 个并发/已完成授权、非普通文件、过大文件或上下文已关闭。
   */
  async add(owner, path) {
    ensure(this.#grants.size + this.#pending.size < 100, '已选文件过多，请先移除部分文件')
    const reservation = { owner }
    this.#pending.add(reservation)
    try {
      const info = await stat(path)
      ensure(this.#pending.has(reservation), '文件授权上下文已关闭', 'FILE_GRANT_EXPIRED')
      ensure(info.isFile() && info.size <= MAX_FILE, '仅支持 20 MiB 以内的普通文件')
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
   */
  async read(owner, id, limit = MAX_FILE) {
    text(id, 80)
    const grant = this.#grants.get(id)
    ensure(grant?.owner === owner, '文件授权已失效，请重新选择', 'FILE_GRANT_EXPIRED')
    const handle = await open(grant.path, 'r')
    try {
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
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== info.size) throw new AppError('FILE_CHANGED', '文件已变化，请重新选择')
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
   */
  release(owner, id) {
    if (this.#grants.get(id)?.owner === owner) this.#grants.delete(id)
  }

  /**
   * 窗口销毁时撤销已完成授权及正在等待 stat 的申请，迟到申请不能重新加入授权表。
   * @param {number} owner 已关闭窗口的 ID；不影响其他窗口。
   * @returns {void} 已发出的读取也会在返回内容前再次确认授权是否仍有效。
   */
  clear(owner) {
    for (const reservation of this.#pending)
      if (reservation.owner === owner) this.#pending.delete(reservation)
    for (const [id, grant] of this.#grants) {
      if (grant.owner === owner) this.#grants.delete(id)
    }
  }
}
