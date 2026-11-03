import { ref } from 'vue'
import { defineStore } from 'pinia'
import { unwrap } from '../core/desktop.js'

/**
 * 请求/传输任务的界面投影，不保存响应内容、路径或凭据。
 * 完成历史最多 50 条，但进行中任务全部保留，确保长任务始终有取消入口。
 */
export const useTasks = defineStore('tasks', () => {
  const items = ref([])
  let resetRevision = 0
  function update(task) {
    // reset 是窗口/凭据上下文边界，不能把它当成缺少 id 的普通任务插入列表。
    if (task.type === 'reset') {
      resetRevision++
      items.value = []
      return
    }
    const index = items.value.findIndex((item) => item.id === task.id)
    if (index < 0) items.value.unshift(task)
    else items.value[index] = task
    items.value = [
      ...items.value.filter((item) => item.status === 'running'),
      ...items.value.filter((item) => item.status !== 'running').slice(0, 50),
    ]
  }
  /**
   * 先订阅、再拉快照，避免启动间隙漏事件；已收到事件的任务优先于较早的快照。
   * @returns {Promise<Function>} 成功后返回 unsubscribe，由根组件负责解除；失败时内部立即解绑。
   * 订阅后若收到 reset，整份旧快照作废，不能把上一个凭据上下文的任务恢复回来。
   */
  async function connect() {
    const unsubscribe = window.desktop.tasks.subscribe(update)
    const snapshotRevision = resetRevision
    try {
      const list = await unwrap((api) => api.tasks.list())
      if (snapshotRevision === resetRevision) {
        for (const task of list) if (!items.value.some((item) => item.id === task.id)) update(task)
      }
      return unsubscribe
    } catch (error) {
      unsubscribe()
      throw error
    }
  }
  return { items, connect, cancel: (id) => unwrap((api) => api.tasks.cancel(id)) }
})
