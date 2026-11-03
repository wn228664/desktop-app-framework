import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { unwrap } from '../core/desktop.js'

/**
 * 跨页面的偏好快照。主进程拥有持久化与系统副作用，store 不直接改文件、启动项或窗口设置。
 * value 只在 IPC 成功后更新，避免界面先切换成功、落盘却失败的状态分裂。
 */
export const usePreferences = defineStore('preferences', () => {
  const value = ref({
    theme: 'system',
    compact: false,
    zoom: 1,
    closeToTray: false,
    launchAtLogin: false,
  })
  const saving = ref(false)
  const systemDark = ref(matchMedia('(prefers-color-scheme: dark)').matches)
  const dark = computed(
    () => value.value.theme === 'dark' || (value.value.theme === 'system' && systemDark.value),
  )
  let queue = Promise.resolve()

  watch(
    [dark, () => value.value.compact],
    () => {
      document.documentElement.classList.toggle('dark', dark.value)
      document.documentElement.dataset.density = value.value.compact ? 'compact' : 'comfortable'
    },
    { immediate: true },
  )

  /**
   * 应用启动时加载一次，由 App 初始化门禁等待完成后再开放设置页面。
   * @returns {Promise<void>} 失败向上抛给应用错误页，不静默套用一份看似成功的本地快照。
   */
  async function load() {
    value.value = await unwrap((api) => api.preferences.get())
  }

  /**
   * @param {Object} patch 普通偏好补丁；保存前复制，后续修改原对象不会改动已排队内容。
   * @returns {Promise<void>} 本笔落盘完成后结束，失败向调用方拒绝并保留原显示值。
   * store 与主进程都串行处理，分别保护 UI 快照顺序和系统/磁盘事务顺序。
   */
  function save(patch) {
    const next = structuredClone(patch)
    const task = queue.then(async () => {
      saving.value = true
      try {
        value.value = await unwrap((api) => api.preferences.set(next))
      } finally {
        saving.value = false
      }
    })
    queue = task.catch(() => {})
    return task
  }

  /**
   * @returns {Function} 解除 matchMedia 监听的函数，由应用根组件在作用域销毁时调用。
   * 系统主题变化只影响 theme=system 的最终显示，不把系统临时外观写成用户明确偏好。
   */
  function observeSystemTheme() {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = (event) => {
      systemDark.value = event.matches
    }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }

  return { value, saving, dark, load, save, observeSystemTheme }
})
