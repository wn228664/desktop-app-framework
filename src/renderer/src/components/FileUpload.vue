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

const props = defineProps({
  path: { type: String, default: '' },
  field: { type: String, default: 'file' },
})
const emit = defineEmits(['uploaded', 'error'])
const files = ref([])
const { run, pending, cancel, error } = useAsyncAction()
const selecting = ref(false)
let disposed = false
async function pick() {
  // 原生对话框返回时组件可能已离开页面，迟到的授权必须直接释放，不能重新写回列表。
  if (selecting.value || pending.value) return
  selecting.value = true
  try {
    const result = await unwrap((api) => api.files.pick())
    if (disposed) {
      for (const file of result) void unwrap((api) => api.files.release(file.id)).catch(() => {})
      return
    }
    files.value.push(...result)
  } catch (failure) {
    emit('error', failure)
  } finally {
    selecting.value = false
  }
}
async function remove(file) {
  // 先从可上传队列移除；释放授权失败不能使已成功上传的文件再次提交。
  files.value = files.value.filter((item) => item.id !== file.id)
  try {
    await unwrap((api) => api.files.release(file.id))
  } catch (failure) {
    emit('error', failure)
  }
}
async function upload() {
  // 取队列快照并顺序执行，避免并行文件共享同一提交状态；失败从未完成项恢复，由用户决定重试。
  try {
    await run(async (signal) => {
      for (const file of [...files.value]) {
        const result = await transfer(
          'upload',
          { path: props.path, field: props.field, fileId: file.id },
          signal,
        )
        signal.throwIfAborted()
        emit('uploaded', { file, result })
        await remove(file)
      }
    })
  } catch {
    /* 失败保留未完成文件，用户可重试或移除。 */
  }
}
onScopeDispose(() => {
  disposed = true
  for (const file of files.value) void unwrap((api) => api.files.release(file.id)).catch(() => {})
})
</script>

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
