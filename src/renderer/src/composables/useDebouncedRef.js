import { customRef, onScopeDispose } from 'vue'

/**
 * 在 setup 中创建末次输入生效的防抖 ref；每次赋值重置等待，作用域销毁会清理计时器。
 * @param {*} [initial=''] 初始值，不做复制；若为对象，内部属性变化不受此防抖控制。
 * @param {number} [milliseconds=300] 等待毫秒数，应提供非负有限值。
 * @returns {import('vue').Ref} 读取仍为上次已提交值，等待结束后才替换值并触发依赖。
 * 若按钮“搜索”需要立即提交当前输入，应使用普通草稿 ref，不能从尚未生效的防抖 ref 取值。
 *
 * 创建按最后一次输入生效的防抖 ref，并绑定作用域清理。
 */
export function useDebouncedRef(initial = '', milliseconds = 300) {
  // value：最后一次已经生效的 ref 值，等待期间保持不变。
  let value = initial
  // timer：最新赋值的尾沿计时器，覆盖输入和销毁时清理。
  let timer
  onScopeDispose(
    /**
     * 销毁作用域时清除未触发的尾沿计时器。
     */
    () => clearTimeout(timer),
  )
  return customRef(
    /**
     * 向 Vue 提供读取收集与延迟赋值的访问器。
     * track：Vue customRef 的依赖收集入口，仅在读取时调用。
     * trigger：Vue customRef 的依赖触发入口，仅在值实际提交后调用。
     */
    (track, trigger) => ({
      /**
       * 收集依赖并返回最后已生效值。
       */
      get() {
        track()
        return value
      },
      /**
       * 替换旧等待计时器，延迟提交本次新值。
       * next：本次待提交的新值，后续赋值会取消其计时器。
       */
      set(next) {
        clearTimeout(timer)
        timer = setTimeout(
          /**
           * 提交本次等待后的值并通知 Vue 依赖。
           */
          () => {
            value = next
            trigger()
          },
          milliseconds,
        )
      },
    }),
  )
}
