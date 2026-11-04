<script setup>
/**
 * 原生能力演示页：所有特权操作都经过固定桌面桥，页面不持有 Node 或文件路径。
 * 文件、剪贴板、通知与下载只在用户操作后触发；不在 mounted 时读取用户剪贴板或文件。
 * 文本草稿仅存当前页面，离开页面会丢弃；保存成功与用户取消必须按 saved 区分。
 */
import { onScopeDispose, ref } from 'vue'
import { ElMessage } from 'element-plus'
import FrameworkPage from '../components/FrameworkPage.vue'
import AsyncButton from '../components/AsyncButton.vue'
import { unwrap, transfer } from '../core/desktop.js'
import { formatBytes, isHttpsUrl } from '../core/format.js'
import { useTasks } from '../stores/tasks.js'

// tasks：共享任务列表投影，页面仅观察和提供取消入口。
const tasks = useTasks()
// content：当前文本文件草稿 ref，初值空串，只在显式另存时写入。
const content = ref('')
// downloadUrl：用户填写的 HTTPS 下载草稿，主进程仍检查来源白名单。
const downloadUrl = ref('')
// clipboardValue：用户显式读取或编辑的剪贴板草稿，不自动轮询。
const clipboardValue = ref('')
// selected：所预览文件的公开名称 ref，未选择时为 null。
const selected = ref(null)
// disposed：当前组件或控制器是否已销毁，初始 false，阻止迟到结果回填。
let disposed = false
// showError：展示公开操作失败，不输出底层文件路径。
const showError =
  /**
   * 展示明确公开的操作失败消息。
   * error：当前公开失败或错误 ref，主动取消不追加失败提示。
   */
  (error) => ElMessage.error(error.message)
// showSaved：只在 saved=true 时显示保存成功的回调。
const showSaved =
  /**
   * 仅在用户实际完成保存时提示成功。
   * result：当前有效周期的操作结果，具体形状由被调用契约定义。
   */
  (result) => {
    if (result.saved) ElMessage.success('文件已保存')
  }
/**
 * 原生多选后只预览第一份 UTF-8 文本；其余授权也必须在 finally 释放。
 * 组件离开后不再写回内容，但迟到的文件结果仍需完成授权清理。
 * @returns {Promise<void>} 用户取消选择时保留原草稿与文件名。
 *
 * 原生多选后预览第一份文本，finally 释放所有授权，离页不回填。
 */
async function pickText() {
  // files：原生选择返回的授权列表，预览后全部释放。
  const files = await unwrap(
    /**
     * 请求原生文件选择授权。
     * api：沙盒 preload 的固定 desktop 能力接口。
     */
    (api) => api.files.pick(),
  )
  if (!files.length) return
  try {
    // value：第一份已授权文件的 UTF-8 文本内容。
    const value = await unwrap(
      /**
       * 凭第一份授权 ID 读取有界 UTF-8 文本。
       * api：沙盒 preload 的固定 desktop 能力接口。
       */
      (api) => api.files.readText(files[0].id),
    )
    if (!disposed) {
      content.value = value
      selected.value = files[0].name
    }
  } finally {
    // file：待释放的单个不透明文件授权。
    for (const file of files)
      await unwrap(
        /**
         * 释放本次选择的单个文件能力。
         * api：沙盒 preload 的固定 desktop 能力接口。
         */
        (api) => api.files.release(file.id),
      )
  }
}
/**
 * 把当前文本草稿交给原生另存为能力。
 */
async function saveText() {
  return unwrap(
    /**
     * 发送当前文本快照，目标路径由系统对话框决定。
     * api：沙盒 preload 的固定 desktop 能力接口。
     */
    (api) => api.files.saveText({ content: content.value }),
  )
}
/**
 * 用户触发时读取文本剪贴板到本页。
 */
async function readClipboard() {
  clipboardValue.value = await unwrap(
    /**
     * 调用固定剪贴板读取桥，不访问 Node。
     * api：沙盒 preload 的固定 desktop 能力接口。
     */
    (api) => api.clipboard.read(),
  )
}
/**
 * @param {AbortSignal} signal 来自 AsyncButton，交给 transfer 绑定主进程下载任务。
 * @returns {Promise<{saved:boolean}>} 下载成功或用户取消选择；来源是否批准仍由主进程判断。
 *
 * 校验下载输入反馈后交给主进程下载，结果区分保存和取消。
 */
async function download(signal) {
  if (!isHttpsUrl(downloadUrl.value)) throw new Error('请输入不含凭据的 HTTPS 地址')
  return transfer('download', { url: downloadUrl.value }, signal)
}
// statuses：公开任务状态到中文展示名称的映射。
const statuses = { running: '进行中', success: '已完成', cancelled: '已取消', failed: '未完成' }
onScopeDispose(
  /**
   * 标记页面销毁，阻止迟到的文本内容回填。
   */
  () => {
    disposed = true
  },
)
</script>

<!-- 模板绑定：复制与通知 action 均为无参用户点击工厂，内层 api 是固定沙盒桥。任务循环 task 为公开任务快照，以 id 作键；取消只发送当前 ID，失败交 showError。 -->
<template>
  <FrameworkPage title="桌面能力" description="用明确授权的原生接口连接设备，任务状态统一呈现。">
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading">
          <h2>文本文件</h2>
          <span class="subtle-badge">Native files</span>
        </div>
        <p class="panel-description">选择 UTF-8 文本读取（最多 1 MiB），或将编辑内容另存为文件。</p>
        <el-input
          v-model="content"
          type="textarea"
          :rows="6"
          :maxlength="1048576"
          aria-label="文本文件内容"
          placeholder="打开文本文件，或在这里输入内容"
        />
        <p class="file-caption truncate">{{ selected || '尚未选择文件' }}</p>
        <div class="button-row">
          <AsyncButton :action="pickText" @error="showError">打开文本</AsyncButton
          ><AsyncButton type="primary" :action="saveText" @success="showSaved" @error="showError"
            >另存为</AsyncButton
          >
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>剪贴板与通知</h2>
          <span class="subtle-badge">System</span>
        </div>
        <p class="panel-description">
          仅在点击时读取剪贴板；通知是否展示由系统权限与专注模式决定。
        </p>
        <el-input
          v-model="clipboardValue"
          type="textarea"
          :rows="4"
          :maxlength="1048576"
          placeholder="输入或读取剪贴板文本"
          aria-label="剪贴板文本"
        />
        <div class="button-row">
          <AsyncButton
            :action="() => unwrap((api) => api.clipboard.write(clipboardValue))"
            @success="ElMessage.success('已复制')"
            @error="showError"
            >复制文本</AsyncButton
          ><AsyncButton :action="readClipboard" @error="showError">读取剪贴板</AsyncButton
          ><AsyncButton
            :action="
              () =>
                unwrap((api) =>
                  api.notify({ title: 'Desktop Framework', body: '这是一条本地系统通知。' }),
                )
            "
            @error="showError"
            >发送通知</AsyncButton
          >
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>可信来源下载</h2>
          <span class="subtle-badge">Transfer</span>
        </div>
        <p class="panel-description">
          需先配置下载来源白名单。通过系统对话框选择位置，下载完成后原子替换。
        </p>
        <el-input
          v-model="downloadUrl"
          placeholder="https://…"
          aria-label="下载地址"
          maxlength="2000"
        />
        <div class="button-row">
          <AsyncButton type="primary" :action="download" @success="showSaved" @error="showError"
            >选择位置并下载</AsyncButton
          >
        </div>
        <div class="inline-note">支持进度、取消、超时和临时文件清理。下载不携带 API 令牌。</div>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>传输与请求任务</h2>
          <span class="subtle-badge">最多保留 50 条</span>
        </div>
        <el-empty
          v-if="!tasks.items.length"
          description="任务会在开始请求或传输后显示"
          :image-size="72"
        />
        <ul v-else class="task-list">
          <li v-for="task in tasks.items" :key="task.id">
            <div class="task-heading">
              <strong>{{ task.kind }}</strong
              ><span>{{ statuses[task.status] }}</span>
            </div>
            <el-progress
              v-if="task.total"
              :percentage="Math.min(100, Math.round((task.completed / task.total) * 100))"
              :status="task.status === 'success' ? 'success' : undefined"
            />
            <div v-else-if="task.status === 'running'" class="indeterminate-progress" role="status">
              正在处理…
            </div>
            <small v-if="task.completed"
              >{{ formatBytes(task.completed) }}
              <span v-if="task.total">/ {{ formatBytes(task.total) }}</span></small
            ><el-button
              v-if="task.status === 'running'"
              size="small"
              @click="tasks.cancel(task.id).catch(showError)"
              >取消任务</el-button
            >
          </li>
        </ul>
      </section>
    </div>
  </FrameworkPage>
</template>
