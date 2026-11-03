import { AppError } from '../../shared/errors.js'
import { ensure, requestId } from '../../shared/validation.js'

/**
 * 主进程任务注册表，统一请求/传输的超时、取消、进度和窗口归属。
 * 并行资源最多 8 个；完成历史最多 50 条。取消不等于远端写入回滚，也不强杀未响应 signal 的操作。
 */
export class Tasks {
  #running = new Map()
  #history = new Map()
  /**
   * @param {Function} notify 接收 (owner,event)；event 为任务快照或 {type:'reset'}。
   * 通知仅用于界面观察，投递失败不改变调用 Promise 的结果。
   */
  constructor(notify) {
    this.notify = notify
  }

  /**
   * @param {number} owner 发起任务的 webContents.id，也是取消权限的归属。
   * @param {string} id 当前进行中任务中唯一的请求 ID，格式由 requestId 校验。
   * @param {string} kind 展示分类，例如 request、upload、download，不参与业务判断。
   * @param {Function} operation 接收 (signal,update)，返回最终结果；等待后应检查 signal 再提交副作用。
   * @param {number} [timeout=60000] 超时毫秒数，从任务注册时开始计算，含原生对话框等待。
   * @returns {Promise<*>} operation 的结果；取消/超时即使遇到迟到成功也不会返回成功结果。
   * @throws {AppError|Error} 重复 ID、并发上限、取消、超时或 operation 本身的异常。
   */
  async run(owner, id, kind, operation, timeout = 60_000) {
    requestId(id)
    ensure(!this.#running.has(id), '请求标识重复')
    ensure(this.#running.size < 8, '并行任务已达上限，请稍后重试', 'BUSY')
    const controller = new AbortController()
    const task = { id, owner, kind, status: 'running', completed: 0, total: 0 }
    const entry = { controller, task, active: true }
    this.#running.set(id, entry)
    const update = (progress = {}) => {
      if (!entry.active) return
      Object.assign(task, progress)
      // 窗口关闭或观察者异常不能改变任务结果，也不能阻断 finally 清理。
      try {
        this.notify(owner, { ...task, owner: undefined })
      } catch {
        /* 进度是通知，任务结果仍由调用 Promise 返回。 */
      }
    }
    const timer = setTimeout(() => controller.abort(new AppError('TIMEOUT', '操作超时')), timeout)
    update()
    try {
      const result = await operation(controller.signal, update)
      controller.signal.throwIfAborted()
      update({ status: 'success' })
      return result
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error
      update({ status: reason?.code === 'CANCELLED' ? 'cancelled' : 'failed' })
      throw reason
    } finally {
      clearTimeout(timer)
      this.#running.delete(id)
      if (entry.active) this.#history.set(id, { ...task })
      if (this.#history.size > 50) this.#history.delete(this.#history.keys().next().value)
    }
  }

  /**
   * 用户主动取消单个任务；未知任务、其他窗口的任务及已结束任务均按幂等操作处理。
   * @param {number} owner 当前窗口 ID。
   * @param {string} id 合法任务 ID；格式错误仍会拒绝。
   * @returns {void} 发出 AbortSignal，资源槽位在 operation 真正结束后释放。
   */
  cancel(owner, id) {
    requestId(id)
    const entry = this.#running.get(id)
    if (entry?.task.owner === owner) {
      entry.controller.abort(new AppError('CANCELLED', '操作已取消'))
    }
  }

  /**
   * 撤销整个窗口/凭据上下文，取消旧任务并清空历史；已在执行的旧结果不能恢复历史。
   * @param {number} owner 需要清理的窗口 ID。
   * @returns {void} 向仍存活的窗口发送 reset；相同 owner 后续仍可创建新任务。
   */
  clear(owner) {
    for (const entry of this.#running.values()) {
      if (entry.task.owner === owner) {
        entry.active = false
        entry.controller.abort(new AppError('CANCELLED', '任务上下文已清理'))
      }
    }
    for (const [id, task] of this.#history) if (task.owner === owner) this.#history.delete(id)
    // 同一窗口切换凭据也会清理任务，通知 UI 撤销旧的运行中状态。
    try {
      this.notify(owner, { type: 'reset' })
    } catch {
      /* 窗口销毁时无需再投递重置。 */
    }
  }

  /**
   * @param {number} owner 当前窗口 ID。
   * @returns {Array<Object>} 只含该窗口有效任务的副本；不公开 owner、控制器或响应内容。
   */
  list(owner) {
    return [
      ...this.#history.values(),
      ...[...this.#running.values()].filter((entry) => entry.active).map(({ task }) => task),
    ]
      .filter((task) => task.owner === owner)
      .map((task) => {
        const value = { ...task }
        delete value.owner
        return value
      })
  }
}
