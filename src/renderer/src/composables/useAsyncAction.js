import { onScopeDispose, ref } from 'vue'
import { createAsyncAction } from '../core/async-action.js'

/**
 * 在 Vue setup/有效 effectScope 内创建动作状态，作用域销毁时自动 dispose。
 * @returns {{pending:import('vue').Ref<boolean>,error:import('vue').Ref,run:Function,cancel:Function}}
 * pending/error 属于当前调用方，不共享到全局；run(operation) 的 operation 接收 AbortSignal。
 * 错误留在 error，同时 run 仍会拒绝 Promise，调用方需要 catch 并选择内联提示或通知。
 * 取消立即解锁 UI、清理 error，旧结果不会覆盖新动作；不能回滚已完成的服务端写入。
 *
 * 建立当前作用域专属 pending/error 并在销毁时释放动作。
 */
export function useAsyncAction() {
  // pending：当前动作等待状态 ref，初始 false，既驱动外观也同步拦截重复入口。
  const pending = ref(false)
  // error：当前公开失败或错误 ref，主动取消不追加失败提示。
  const error = ref(null)
  // action：与当前 Vue 作用域同寿命的异步控制器。
  const action = createAsyncAction(
    /**
     * 将控制器状态投影到 Vue ref，不把缺省 error 当清空命令。
     * state：控制器发布的状态补丁，只有显式包含 error 才更新错误 ref。
     */
    (state) => {
      pending.value = state.pending
      if (Object.hasOwn(state, 'error')) error.value = state.error
    },
  )
  onScopeDispose(
    /**
     * 作用域结束时取消并永久销毁控制器。
     */
    () => action.dispose(),
  )
  return { pending, error, run: action.run.bind(action), cancel: action.cancel.bind(action) }
}
