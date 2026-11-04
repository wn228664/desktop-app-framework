<script setup>
/**
 * 原生文件授权与顺序上传组件，不接收任意磁盘路径，也不把选择结果写入长期存储。
 * Props：path 为相对 API 上传地址，默认空；field 为 FormData 字段名，默认 file。
 * path 为空时选择文件仍可用，上传入口禁用并说明配置要求；API 基址需在构建配置中提供。
 * Events：uploaded({file,result}) 每成功处理一份 HTTP/JSON 响应发出一次，业务成功条件由接入方解释；
 * error(error) 用于选择/授权清理失败；上传失败同时保留在组件内联错误中。
 * 每份文件授权有独立 ID；单文件最多 20 MiB，一次选择最多 10 份，总授权上限由主进程控制。
 * 取消不能撤回服务端已接收的上传；卸载会取消当前任务并尝试释放尚未移除的文件授权。
 * 用法：<FileUpload path="uploads" field="attachment" @uploaded="handleUploaded" @error="showError" />
 */
import { onScopeDispose, ref } from 'vue'
import { unwrap, transfer } from '../core/desktop.js'
import { formatBytes } from '../core/format.js'
import { useAsyncAction } from '../composables/useAsyncAction.js'

// props：父级只读组件参数，字段默认值与事件责任见 props 说明。
const props = defineProps({
  /** 属性 path：相对 API 上传路径，默认空串；空时仍可选择文件但禁用上传。 */
  path: { type: String, default: '' },
  /** 属性 field：multipart 文件字段名称，默认 file，主进程限制长度。 */
  field: { type: String, default: 'file' },
})
// emit：当前组件事件发布器，通知父级但不直接修改受控模型。
const emit = defineEmits(['uploaded', 'error'])
// files：当前未完成的文件授权队列，只持有 id/名称/大小。
const files = ref([])
// run：当前作用域异步动作入口，同一周期互斥并拦截取消后的迟到结果。
// pending：当前动作等待状态 ref，初始 false，既驱动外观也同步拦截重复入口。
// cancel：取消本作用域当前动作并解除界面等待，不能撤销已经发生的外部写入。
// error：当前公开失败或错误 ref，主动取消不追加失败提示。
const { run, pending, cancel, error } = useAsyncAction()
// selecting：原生选择器等待状态，初始 false，选择期间阻止再次打开。
const selecting = ref(false)
// disposed：当前组件或控制器是否已销毁，初始 false，阻止迟到结果回填。
let disposed = false
/**
 * 互斥打开原生选择器，离页后迟到授权直接释放。
 */
async function pick() {
  // 原生对话框返回时组件可能已离开页面，迟到的授权必须直接释放，不能重新写回列表。
  if (selecting.value || pending.value) return
  selecting.value = true
  try {
    // result：当前有效周期的操作结果，具体形状由被调用契约定义。
    const result = await unwrap(
      /**
       * 调用固定的原生文件选择能力。
       * api：沙盒 preload 的固定 desktop 能力接口。
       */
      (api) => api.files.pick(),
    )
    if (disposed) {
      // file：当前窗口持有的单个文件授权，释放不删除用户文件。
      for (const file of result)
        void unwrap(
          /**
           * 释放组件销毁后才返回的单个授权。
           * api：沙盒 preload 的固定 desktop 能力接口。
           */
          (api) => api.files.release(file.id),
        ).catch(
          /**
           * 清理中消费授权释放失败，组件已销毁时不再发新事件。
           */
          () => {},
        )
      return
    }
    files.value.push(...result)
  } catch (failure) {
    // failure：当前捕获的操作失败，仅向所属组件或页面反馈公开提示。

    emit('error', failure)
  } finally {
    selecting.value = false
  }
}
/**
 * 先从队列移除指定文件，再尝试释放授权，失败以 error 通知。
 * file：当前窗口持有的单个文件授权，释放不删除用户文件。
 */
async function remove(file) {
  // 先从可上传队列移除；释放授权失败不能使已成功上传的文件再次提交。
  files.value = files.value.filter(
    /**
     * 按授权 id 过滤已移除的文件。
     * item：上传队列候选项，按 id 删除而非按文件名。
     */
    (item) => item.id !== file.id,
  )
  try {
    await unwrap(
      /**
       * 撤销当前窗口的指定文件能力。
       * api：沙盒 preload 的固定 desktop 能力接口。
       */
      (api) => api.files.release(file.id),
    )
  } catch (failure) {
    // failure：当前捕获的操作失败，仅向所属组件或页面反馈公开提示。

    emit('error', failure)
  }
}
/**
 * 取得队列快照后顺序上传，失败保留未完成项供用户选择重试。
 */
async function upload() {
  // 取队列快照并顺序执行，避免并行文件共享同一提交状态；失败从未完成项恢复，由用户决定重试。
  try {
    await run(
      /**
       * 逐份上传当前队列快照，复验取消后才发 uploaded 并移除。
       * signal：当前动作 AbortSignal，异步完成后提交结果或副作用前须复验。
       */
      async (signal) => {
        // file：当前窗口持有的单个文件授权，释放不删除用户文件。
        for (const file of [...files.value]) {
          // result：当前有效周期的操作结果，具体形状由被调用契约定义。
          const result = await transfer(
            'upload',
            { path: props.path, field: props.field, fileId: file.id },
            signal,
          )
          signal.throwIfAborted()
          emit('uploaded', { file, result })
          await remove(file)
        }
      },
    )
  } catch {
    /* 失败保留未完成文件，用户可重试或移除。 */
  }
}
onScopeDispose(
  /**
   * 标记组件销毁，释放剩余授权；动作由 useAsyncAction 同步取消。
   */
  () => {
    disposed = true
    // file：当前窗口持有的单个文件授权，释放不删除用户文件。
    for (const file of files.value)
      void unwrap(
        /**
         * 撤销销毁组件队列里的单个文件授权。
         * api：沙盒 preload 的固定 desktop 能力接口。
         */
        (api) => api.files.release(file.id),
      ).catch(
        /**
         * 销毁清理的失败不再回填已卸载界面。
         */
        () => {},
      )
  },
)
</script>

<!-- 模板绑定：file 为当前未完成授权项，id 既作为稳定键也作为移除/释放的能力 ID；不在模板读取本地文件路径。 -->
<template>
  <section class="file-upload">
    <div class="upload-target">
      <span class="upload-mark">↑</span><strong>从设备选择文件</strong>
      <p>原生文件授权 · 单个文件最多 20 MiB</p>
      <el-button :loading="selecting" :disabled="pending" @click="pick">选择文件</el-button>
    </div>
    <ul v-if="files.length" class="file-list">
      <li v-for="file in files" :key="file.id">
        <div class="truncate">
          <strong>{{ file.name }}</strong
          ><small>{{ formatBytes(file.size) }}</small>
        </div>
        <el-button text :disabled="pending" @click="remove(file)">移除</el-button>
      </li>
    </ul>
    <el-alert
      v-if="!path"
      title="尚未接入上传地址；选择文件可用，上传需由接入方提供相对 API 路径。"
      type="info"
      :closable="false"
    />
    <el-alert v-if="error" :title="error.message" type="error" :closable="false" />
    <div v-if="files.length" class="button-row">
      <el-button type="primary" :loading="pending" :disabled="!path || pending" @click="upload"
        >开始上传</el-button
      ><el-button v-if="pending" @click="cancel">取消上传</el-button>
    </div>
  </section>
</template>
