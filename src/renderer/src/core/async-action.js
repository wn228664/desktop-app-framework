/**
 * 与 Vue 无关的单动作控制器，适用于按钮提交、表格加载和浮层保存。
 * @param {Function} [onChange] 接收 {pending,error?}；未携带 error 表示仅更新 pending，不清除错误。
 * @returns {{run:Function,cancel:Function,dispose:Function}} 同一控制器同一时刻只管理一个动作。
 * 重复 run 复用进行中的 Promise；UI 若只允许一次成功事件，仍需在点击入口同步检查 pending。
 *
 * 创建单动作控制器，同步互斥、版本隔离并保留失败拒绝。
 */
export function createAsyncAction /**
 * 缺省状态观察器，不额外持久化或弹提示。
 */(onChange = () => {}) {
  // revision：动作版本，启动和取消递增，用于隔离迟到结果。
  let revision = 0
  // controller：本周期 AbortController，取消时通知外部操作。
  let controller
  // current：当前进行中 Promise，重复 run 复用它；取消立即清空 UI 互斥。
  let current
  // disposed：当前组件或控制器是否已销毁，初始 false，阻止迟到结果回填。
  let disposed = false
  // publish：只在控制器仍有效时发布状态的入口。
  const publish =
    /**
     * 仅在控制器未销毁时转交状态补丁。
     * value：发布给观察器的 pending/error 状态补丁。
     */
    (value) => {
      if (!disposed) onChange(value)
    }
  return {
    /**
     * @param {Function} operation 接收 AbortSignal，可返回普通值或 Promise；写操作由调用方决定幂等策略。
     * @returns {Promise<*>} 当前动作结果；取消后的迟到成功会转为 AbortError，不影响后来启动的动作。
     * operation 应在等待后、修改外部状态前检查 signal，控制器无法撤销已经提交的外部副作用。
     *
     * 启动新动作或复用进行中 Promise，所有终态都按版本隔离。
     */
    run(operation) {
      if (disposed) return Promise.reject(new Error('动作已销毁'))
      if (current) return current
      // ticket：run 捕获的版本号，完成后匹配才允许交付。
      const ticket = ++revision
      controller = new AbortController()
      // signal：此周期取消信号，开始副作用和返回结果前都检查。
      const signal = controller.signal
      publish({ pending: true, error: null })
      current = Promise.resolve()
        .then(
          /**
           * 副作用开始前再次检查是否预先取消。
           */
          () => {
            signal.throwIfAborted()
            return operation(signal)
          },
        )
        .then(
          /**
           * 成功交付前核对版本，旧周期转为 AbortError。
           * result：当前有效周期的操作结果，具体形状由被调用契约定义。
           */
          (result) => {
            if (ticket !== revision) throw new DOMException('操作已取消', 'AbortError')
            return result
          },
        )
        .catch(
          /**
           * 只向当前未取消周期写失败状态，同时继续拒绝。
           * error：当前公开失败或错误 ref，主动取消不追加失败提示。
           */
          (error) => {
            if (ticket === revision && !signal.aborted) publish({ pending: false, error })
            throw error
          },
        )
        .finally(
          /**
           * 只归还本周期持有的界面互斥，不释放新周期。
           */
          () => {
            if (ticket === revision) {
              current = null
              publish({ pending: false })
            }
          },
        )
      return current
    },
    /**
     * 立即解除 UI 互斥并使旧结果失效，可随后 run 新动作。
     * 旧 Promise 是否立即结束取决于 operation 是否响应 signal，不能把取消理解为强杀异步代码。
     *
     * 推进版本并取消当前 signal，允许后续新动作。
     */
    cancel() {
      revision++
      controller?.abort()
      current = null
      publish({ pending: false, error: null })
    },
    /**
     * 先取消，再永久停止运行和观察通知。
     */
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
 *
 * 等待指定时长，取消时清理计时器并拒绝。
 */
export function delay(milliseconds, signal) {
  signal?.throwIfAborted()
  return new Promise(
    /**
     * 建立独立延迟 Promise 并关联取消监听。
     * resolve：当前延迟 Promise 的成功入口。
     * reject：当前延迟 Promise 的拒绝入口。
     */
    (resolve, reject) => {
      // cancel：当前延时的取消处理器，清除 timer 后以取消原因拒绝。
      const cancel =
        /**
         * 清理延迟计时器，以 signal 原因或 AbortError 拒绝。
         */
        () => {
          clearTimeout(timer)
          reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'))
        }
      // timer：当前延时的 setTimeout 句柄。
      const timer = setTimeout(
        /**
         * 时间到后解绑取消监听并成功完成延迟。
         */
        () => {
          signal?.removeEventListener('abort', cancel)
          resolve()
        },
        milliseconds,
      )
      signal?.addEventListener('abort', cancel, { once: true })
    },
  )
}
