import { customRef, onScopeDispose } from 'vue'

/**
 * 在 setup 中创建末次输入生效的防抖 ref；每次赋值重置等待，作用域销毁会清理计时器。
 * @param {*} [initial=''] 初始值，不做复制；若为对象，内部属性变化不受此防抖控制。
 * @param {number} [milliseconds=300] 等待毫秒数，应提供非负有限值。
 * @returns {import('vue').Ref} 读取仍为上次已提交值，等待结束后才替换值并触发依赖。
 * 若按钮“搜索”需要立即提交当前输入，应使用普通草稿 ref，不能从尚未生效的防抖 ref 取值。
 */
export function useDebouncedRef(initial = '', milliseconds = 300) {
  let value = initial
  let timer
  onScopeDispose(() => clearTimeout(timer))
  return customRef((track, trigger) => ({
    get() {
      track()
      return value
    },
    set(next) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        value = next
        trigger()
      }, milliseconds)
    },
  }))
}
