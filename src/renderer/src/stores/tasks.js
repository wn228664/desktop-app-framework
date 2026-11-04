import { ref } from 'vue'
import { defineStore } from 'pinia'
import { unwrap } from '../core/desktop.js'

/**
 * 请求/传输任务的界面投影，不保存响应内容、路径或凭据。
 * 完成历史最多 50 条，但进行中任务全部保留，确保长任务始终有取消入口。
 */
// useTasks：每个 Pinia 应用独立的任务投影 store 工厂。
export const useTasks = defineStore(
  'tasks',
  /**
   * 创建不含私有数据的任务列表及连接动作。
   */
  () => {
    // items：当前有效任务和有限完成历史的 ref，不保存响应和凭据。
    const items = ref([])
    // resetRevision：任务上下文 reset 次数，用于使旧初始化快照整体失效。
    let resetRevision = 0
    /**
     * 按任务 ID 合并事件，reset 清空整个旧上下文。
     * task：公开任务事件或 reset 信号，不可按缺少 id 的普通行混入。
     */
    function update(task) {
      // reset 是窗口/凭据上下文边界，不能把它当成缺少 id 的普通任务插入列表。
      if (task.type === 'reset') {
        resetRevision++
        items.value = []
        return
      }
      // index：当前任务在已有列表中的位置，负数表示首次收到。
      const index = items.value.findIndex(
        /**
         * 按稳定任务 ID 查找已有条目。
         * item：当前公开任务行，按 id 合并且状态决定历史保留。
         */
        (item) => item.id === task.id,
      )
      if (index < 0) items.value.unshift(task)
      else items.value[index] = task
      items.value = [
        ...items.value.filter(
          /**
           * 保留所有运行任务，保证取消入口不被历史上限移除。
           * item：当前公开任务行，按 id 合并且状态决定历史保留。
           */
          (item) => item.status === 'running',
        ),
        ...items.value
          .filter(
            /**
             * 完成历史只保留最近 50 条。
             * item：当前公开任务行，按 id 合并且状态决定历史保留。
             */
            (item) => item.status !== 'running',
          )
          .slice(0, 50),
      ]
    }
    /**
     * 先订阅、再拉快照，避免启动间隙漏事件；已收到事件的任务优先于较早的快照。
     * @returns {Promise<Function>} 成功后返回 unsubscribe，由根组件负责解除；失败时内部立即解绑。
     * 订阅后若收到 reset，整份旧快照作废，不能把上一个凭据上下文的任务恢复回来。
     *
     * 先订阅再读取快照，用版本和任务 ID 避免旧快照覆盖事件。
     */
    async function connect() {
      // unsubscribe：本次任务事件订阅的清理函数，连接失败或根销毁必须调用。
      const unsubscribe = window.desktop.tasks.subscribe(update)
      // snapshotRevision：发起快照请求时捕获的 reset 版本。
      const snapshotRevision = resetRevision
      try {
        // list：固定桥返回的任务快照，已有事件的任务优先。
        const list = await unwrap(
          /**
           * 读取仅属于当前窗口的任务快照。
           * api：沙盒 preload 的固定 desktop 能力接口。
           */
          (api) => api.tasks.list(),
        )
        if (snapshotRevision === resetRevision) {
          // task：公开任务事件或 reset 信号，不可按缺少 id 的普通行混入。
          for (const task of list)
            if (
              !items.value.some(
                /**
                 * 判断此任务是否已由较新的事件加入列表。
                 * item：当前公开任务行，按 id 合并且状态决定历史保留。
                 */
                (item) => item.id === task.id,
              )
            )
              update(task)
        }
        return unsubscribe
      } catch (error) {
        // error：当前公开失败或错误 ref，主动取消不追加失败提示。

        unsubscribe()
        throw error
      }
    }
    return {
      items,
      connect,

      /**
       * 通过固定桥请求取消任务。
       * id：用户请求取消的任务标识，归属由主进程复验。
       */
      cancel: (id) =>
        unwrap(
          /**
           * 把指定任务 ID 传给主进程取消能力。
           * api：沙盒 preload 的固定 desktop 能力接口。
           */
          (api) => api.tasks.cancel(id),
        ),
    }
  },
)
