import { onScopeDispose, ref } from 'vue'
import { createAsyncAction } from '../core/async-action.js'

/**
 * 在 Vue setup/有效 effectScope 内创建动作状态，作用域销毁时自动 dispose。
 * @returns {{pending:import('vue').Ref<boolean>,error:import('vue').Ref,run:Function,cancel:Function}}
 * pending/error 属于当前调用方，不共享到全局；run(operation) 的 operation 接收 AbortSignal。
 * 错误留在 error，同时 run 仍会拒绝 Promise，调用方需要 catch 并选择内联提示或通知。
 * 取消立即解锁 UI、清理 error，旧结果不会覆盖新动作；不能回滚已完成的服务端写入。
 */
export function useAsyncAction() {
  const pending = ref(false)
  const error = ref(null)
  const action = createAsyncAction((state) => {
    pending.value = state.pending
    if (Object.hasOwn(state, 'error')) error.value = state.error
  })
  onScopeDispose(() => action.dispose())
  return { pending, error, run: action.run.bind(action), cancel: action.cancel.bind(action) }
}
