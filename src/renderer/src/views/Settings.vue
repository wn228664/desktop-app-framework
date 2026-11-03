<script setup>
/**
 * 设置页只提交偏好补丁与凭据命令，不自行存储 token 或决定系统权限。
 * 令牌输入是未提交草稿，与主进程当前令牌分离；保存后仅清理本次提交对应的草稿。
 * 更新状态来自订阅与初始化快照，事件版本优先，避免较慢的 info 请求让旧快照覆盖新进度。
 */
import { onMounted, onScopeDispose, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import FrameworkPage from '../components/FrameworkPage.vue'
import AsyncButton from '../components/AsyncButton.vue'
import { usePreferences } from '../stores/preferences.js'
import { unwrap } from '../core/desktop.js'

const preferences = usePreferences()
const token = ref('')
const remember = ref(false)
const update = ref({ status: 'unconfigured' })
const info = ref(null)
let unsubscribe
let disposed = false
let updateRevision = 0
const showError = (error) => ElMessage.error(error.message)
const labels = {
  unconfigured: '未配置更新服务',
  idle: '可以检查更新',
  checking: '正在检查更新',
  available: '有新版本可用',
  current: '当前为最新版本',
  downloading: '正在下载',
  downloaded: '新版本已下载',
  failed: '更新失败',
}
/** 将控件变更交给串行偏好 store；失败由本页展示，控件继续使用上一份成功快照。 */
async function save(patch) {
  try {
    await preferences.save(patch)
  } catch (error) {
    showError(error)
  }
}
/**
 * 显式提交当前令牌与 remember 选择；系统加密或写入失败时保留输入供用户处理。
 * 等待期间用户若编辑出新草稿，旧请求成功不能把新内容一起清空。
 */
async function saveToken() {
  const submitted = token.value
  await unwrap((api) => api.credentials.set({ token: submitted, remember: remember.value }))
  if (token.value === submitted) token.value = ''
  ElMessage.success('访问令牌已设置，界面不保留令牌内容')
}
/**
 * 安装会退出并重启应用，必须先让用户确认已保存工作。
 * 取消确认属于正常分支，不展示错误；确认后仍由主进程检查 downloaded 状态。
 */
async function install() {
  try {
    await ElMessageBox.confirm('应用将退出并安装已下载版本。请先保存内容。', '安装更新', {
      confirmButtonText: '安装并重启',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  await unwrap((api) => api.updates.run('install'))
}
onMounted(async () => {
  try {
    unsubscribe = window.desktop.updates.subscribe((state) => {
      updateRevision++
      update.value = state
    })
    const snapshotRevision = updateRevision
    const [state, appInfo] = await Promise.all([
      unwrap((api) => api.updates.get()),
      unwrap((api) => api.info()),
    ])
    if (!disposed) {
      if (snapshotRevision === updateRevision) update.value = state
      info.value = appInfo
    }
  } catch (error) {
    showError(error)
  }
})
onScopeDispose(() => {
  disposed = true
  unsubscribe?.()
})
</script>

<template>
  <FrameworkPage title="应用设置" description="清晰的偏好设置，可控的系统行为。">
    <div class="settings-stack">
      <section class="panel">
        <div class="panel-heading">
          <h2>外观与显示</h2>
          <span class="subtle-badge">自动保存</span>
        </div>
        <div class="setting-row">
          <div>
            <strong>主题</strong>
            <p>明亮、暗色或跟随系统外观。</p>
          </div>
          <el-segmented
            :model-value="preferences.value.theme"
            :disabled="preferences.saving"
            :options="[
              { label: '跟随系统', value: 'system' },
              { label: '明亮', value: 'light' },
              { label: '暗色', value: 'dark' },
            ]"
            @update:model-value="save({ theme: $event })"
          />
        </div>
        <div class="setting-row">
          <div>
            <strong>界面缩放</strong>
            <p>调整内容比例，布局随可用空间变化。</p>
          </div>
          <el-select
            class="setting-select"
            :model-value="preferences.value.zoom"
            :disabled="preferences.saving"
            aria-label="界面缩放"
            @update:model-value="save({ zoom: $event })"
            ><el-option
              v-for="value in [0.8, 1, 1.25, 1.5]"
              :key="value"
              :label="`${value * 100}%`"
              :value="value"
          /></el-select>
        </div>
        <div class="setting-row">
          <div>
            <strong>紧凑密度</strong>
            <p>缩小常用控件，展示更多内容。</p>
          </div>
          <el-switch
            :model-value="preferences.value.compact"
            :disabled="preferences.saving"
            aria-label="紧凑密度"
            @update:model-value="save({ compact: $event })"
          />
        </div>
      </section>
      <section class="panel">
        <h2>窗口与系统</h2>
        <div class="setting-row">
          <div>
            <strong>关闭窗口时保留在托盘</strong>
            <p>默认关闭；开启后可从托盘菜单显示窗口或退出。</p>
          </div>
          <el-switch
            :model-value="preferences.value.closeToTray"
            :disabled="preferences.saving"
            aria-label="关闭窗口时保留在托盘"
            @update:model-value="save({ closeToTray: $event })"
          />
        </div>
        <div class="setting-row">
          <div>
            <strong>登录系统时启动</strong>
            <p>
              {{
                info?.packaged
                  ? '由系统管理启动项，可在系统设置中关闭。'
                  : '安装后的应用可用，开发模式不修改系统启动项。'
              }}
            </p>
          </div>
          <el-switch
            :model-value="preferences.value.launchAtLogin"
            :disabled="preferences.saving || !info?.packaged"
            aria-label="登录系统时启动"
            @update:model-value="save({ launchAtLogin: $event })"
          />
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>请求凭据</h2>
          <el-tag :type="info?.apiConfigured ? 'success' : 'info'" effect="plain">{{
            info?.apiConfigured ? 'API 已配置' : 'API 未配置'
          }}</el-tag>
        </div>
        <p class="panel-description">
          仅向配置的 API 基址附加 Bearer 令牌。默认只在内存保存，持久化需显式启用系统加密。
        </p>
        <el-input
          v-model="token"
          type="password"
          show-password
          autocomplete="off"
          maxlength="8192"
          aria-label="访问令牌"
          placeholder="接入 API 时设置访问令牌"
        />
        <div class="button-row">
          <el-checkbox v-model="remember">使用系统加密保存在本机</el-checkbox
          ><AsyncButton type="primary" :action="saveToken" @error="showError">设置令牌</AsyncButton
          ><AsyncButton
            :action="() => unwrap((api) => api.credentials.clear())"
            @success="ElMessage.success('访问令牌已清除')"
            @error="showError"
            >清除令牌</AsyncButton
          >
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>版本与更新</h2>
          <span class="subtle-badge">v{{ info?.version || '1.0.0' }}</span>
        </div>
        <p class="panel-description">
          {{ labels[update.status] }}<span v-if="update.version"> · {{ update.version }}</span>
        </p>
        <el-alert
          v-if="update.status === 'unconfigured'"
          title="更新需要正式安装包、HTTPS 发布地址和平台签名。框架未预设发布服务。"
          type="info"
          :closable="false"
        /><el-progress
          v-if="update.status === 'downloading'"
          :percentage="Math.round(update.percent || 0)"
        /><el-alert
          v-if="update.status === 'failed'"
          :title="update.message"
          type="error"
          :closable="false"
        />
        <div class="button-row">
          <AsyncButton
            :action="() => unwrap((api) => api.updates.run('check'))"
            :disabled="['unconfigured', 'checking', 'downloading'].includes(update.status)"
            @error="showError"
            >检查更新</AsyncButton
          ><AsyncButton
            v-if="update.status === 'available'"
            type="primary"
            :action="() => unwrap((api) => api.updates.run('download'))"
            @error="showError"
            >下载新版本</AsyncButton
          ><AsyncButton
            v-if="update.status === 'downloaded'"
            type="primary"
            :action="install"
            @error="showError"
            >安装并重启</AsyncButton
          >
        </div>
      </section>
    </div>
  </FrameworkPage>
</template>
