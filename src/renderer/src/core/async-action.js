/**
 * 与 Vue 无关的单动作控制器，适用于按钮提交、表格加载和浮层保存。
 * @param {Function} [onChange] 接收 {pending,error?}；未携带 error 表示仅更新 pending，不清除错误。
 * @returns {{run:Function,cancel:Function,dispose:Function}} 同一控制器同一时刻只管理一个动作。
 * 重复 run 复用进行中的 Promise；UI 若只允许一次成功事件，仍需在点击入口同步检查 pending。
 */
export function createAsyncAction(onChange = () => {}) {
  let revision = 0
  let controller
  let current
  let disposed = false
  const publish = (value) => {
    if (!disposed) onChange(value)
  }
  return {
    /**
     * @param {Function} operation 接收 AbortSignal，可返回普通值或 Promise；写操作由调用方决定幂等策略。
     * @returns {Promise<*>} 当前动作结果；取消后的迟到成功会转为 AbortError，不影响后来启动的动作。
     * operation 应在等待后、修改外部状态前检查 signal，控制器无法撤销已经提交的外部副作用。
     */
    run(operation) {
      if (disposed) return Promise.reject(new Error('动作已销毁'))
      if (current) return current
      const ticket = ++revision
      controller = new AbortController()
      const signal = controller.signal
      publish({ pending: true, error: null })
      current = Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          return operation(signal)
        })
        .then((result) => {
          if (ticket !== revision) throw new DOMException('操作已取消', 'AbortError')
          return result
        })
        .catch((error) => {
          if (ticket === revision && !signal.aborted) publish({ pending: false, error })
          throw error
        })
        .finally(() => {
          if (ticket === revision) {
            current = null
            publish({ pending: false })
          }
        })
      return current
    },
    /**
     * 立即解除 UI 互斥并使旧结果失效，可随后 run 新动作。
     * 旧 Promise 是否立即结束取决于 operation 是否响应 signal，不能把取消理解为强杀异步代码。
     */
    cancel() {
      revision++
      controller?.abort()
      current = null
      publish({ pending: false, error: null })
    },
    /** 作用域销毁时调用；撤销当前动作并禁止后续 run，同时停止向已销毁 UI 发布状态。 */
    dispose() {
      this.cancel()
      disposed = true
    },
  }
}

/**
 * 可取消延时，只负责等待，不会自动重试任何操作。
 * @param {number} milliseconds 等待毫秒数，应提供非负有限值；遵循平台 setTimeout 精度。
 * @param {AbortSignal} [signal] 已取消时立即抛出，否则取消时清理计时器并拒绝 Promise。
 * @returns {Promise<void>} 时间到达后完成并移除取消监听。
 */
export function delay(milliseconds, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
