import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { unwrap } from '../core/desktop.js'

/**
 * 跨页面的偏好快照。主进程拥有持久化与系统副作用，store 不直接改文件、启动项或窗口设置。
 * value 只在 IPC 成功后更新，避免界面先切换成功、落盘却失败的状态分裂。
 */
// usePreferences：每个 Pinia 应用独立的偏好 store 工厂。
export const usePreferences = defineStore(
  'preferences',
  /**
   * 创建应用级偏好投影和串行保存队列。
   */
  () => {
    // value：最后成功持久化的完整偏好 ref，初始化前使用非敏感默认值。
    const value = ref({
      theme: 'system',
      compact: false,
      zoom: 1,
      closeToTray: false,
      launchAtLogin: false,
    })
    // saving：当前一笔偏好保存是否等待，默认 false。
    const saving = ref(false)
    // systemDark：系统暗色媒体查询的当前匹配结果 ref。
    const systemDark = ref(matchMedia('(prefers-color-scheme: dark)').matches)
    // dark：明确暗色或 system 且系统暗色的派生状态。
    const dark = computed(
      /**
       * 从明确主题和系统外观派生最终暗色状态。
       */
      () => value.value.theme === 'dark' || (value.value.theme === 'system' && systemDark.value),
    )
    // queue：串行保存偏好的 Promise 尾部，失败不阻断后续保存。
    let queue = Promise.resolve()

    watch(
      [
        dark,
        /**
         * 观察当前持久化快照的 compact 字段。
         */
        () => value.value.compact,
      ],
      /**
       * 将已生效主题和密度同步到文档根节点。
       */
      () => {
        document.documentElement.classList.toggle('dark', dark.value)
        document.documentElement.dataset.density = value.value.compact ? 'compact' : 'comfortable'
      },
      { immediate: true },
    )

    /**
     * 应用启动时加载一次，由 App 初始化门禁等待完成后再开放设置页面。
     * @returns {Promise<void>} 失败向上抛给应用错误页，不静默套用一份看似成功的本地快照。
     *
     * 初始化读取主进程最后成功的偏好。
     */
    async function load() {
      value.value = await unwrap(
        /**
         * 调用固定偏好读取能力。
         * api：沙盒 preload 的固定 desktop 能力接口。
         */
        (api) => api.preferences.get(),
      )
    }

    /**
     * @param {Object} patch 普通偏好补丁；保存前复制，后续修改原对象不会改动已排队内容。
     * @returns {Promise<void>} 本笔落盘完成后结束，失败向调用方拒绝并保留原显示值。
     * store 与主进程都串行处理，分别保护 UI 快照顺序和系统/磁盘事务顺序。
     *
     * 复制补丁后排队保存，本笔失败不提前改变快照。
     */
    function save(patch) {
      // next：复制后的本次补丁，排队期间不受原对象更改影响。
      const next = structuredClone(patch)
      // task：本笔保存 Promise，成功更新快照，失败继续拒绝。
      const task = queue.then(
        /**
         * 仅在 IPC 成功后更新偏好，finally 清等待状态。
         */
        async () => {
          saving.value = true
          try {
            value.value = await unwrap(
              /**
               * 把本次独立补丁交给主进程偏好事务。
               * api：沙盒 preload 的固定 desktop 能力接口。
               */
              (api) => api.preferences.set(next),
            )
          } finally {
            saving.value = false
          }
        },
      )
      queue = task.catch(
        /**
         * 恢复队列可执行性，本笔失败仍通过 task 交给页面。
         */
        () => {},
      )
      return task
    }

    /**
     * @returns {Function} 解除 matchMedia 监听的函数，由应用根组件在作用域销毁时调用。
     * 系统主题变化只影响 theme=system 的最终显示，不把系统临时外观写成用户明确偏好。
     *
     * 安装系统外观监听并返回对应清理函数。
     */
    function observeSystemTheme() {
      // media：系统外观 matchMedia 句柄，监听必须在应用销毁时解除。
      const media = matchMedia('(prefers-color-scheme: dark)')
      // update：将系统媒体变化写入 systemDark 的监听引用。
      const update =
        /**
         * 记录系统实际暗色状态，不写成用户明确偏好。
         * event：系统媒体查询变更事件，matches 表示当前是否暗色。
         */
        (event) => {
          systemDark.value = event.matches
        }
      media.addEventListener('change', update)
      return (
        /**
         * 解除本次系统外观监听。
         */
        () => media.removeEventListener('change', update)
      )
    }

    return { value, saving, dark, load, save, observeSystemTheme }
  },
)
