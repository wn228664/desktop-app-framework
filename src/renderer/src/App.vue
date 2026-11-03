<script setup>
/**
 * renderer 生命周期根节点：建立主题监听，等待偏好/应用信息/任务订阅就绪，再渲染页面。
 * ready 是初始化门禁，不是页面加载态；单页请求状态由对应组件负责，避免全局互相阻塞。
 * fatal 同时接收初始化失败与子组件渲染异常，重试会重建初始化链并撤销上一份任务订阅。
 */
import { computed, onErrorCaptured, onMounted, onScopeDispose, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { navigation } from './router.js'
import { usePreferences } from './stores/preferences.js'
import { useTasks } from './stores/tasks.js'
import { unwrap } from './core/desktop.js'
import AppIcon from './components/AppIcon.vue'

const route = useRoute()
const preferences = usePreferences()
const tasks = useTasks()
const info = ref(null)
const fatal = ref('')
const ready = ref(false)
let initializing = false
const reload = () => window.location.reload()
const activeTasks = computed(() => tasks.items.filter((task) => task.status === 'running').length)
const disposeTheme = preferences.observeSystemTheme()
let disposeTasks
let disposed = false
/**
 * 根组件首次挂载或用户重试时执行；同步互斥，避免多份全局监听同时存活。
 * 初始化期间不开放设置控件，防止默认值编辑与迟到的磁盘快照互相覆盖。
 */
async function initialize() {
  if (initializing) return
  initializing = true
  fatal.value = ''
  ready.value = false
  disposeTasks?.()
  disposeTasks = null
  try {
    await preferences.load()
    info.value = await unwrap((api) => api.info())
    if (info.value.storageWarning) ElMessage.warning(info.value.storageWarning)
    const dispose = await tasks.connect()
    if (disposed) dispose()
    else {
      disposeTasks = dispose
      ready.value = true
    }
  } catch (error) {
    fatal.value = error.message
  } finally {
    initializing = false
  }
}
onMounted(initialize)
onScopeDispose(() => {
  disposed = true
  disposeTheme()
  disposeTasks?.()
})
onErrorCaptured((error) => {
  // 阻止错误继续冒泡成空白页；错误页卸载原子树，其内部动作会按各自作用域取消。
  fatal.value = `界面加载失败：${error.message}`
  return false
})
</script>

<template>
  <el-config-provider :locale="zhCn" :size="preferences.value.compact ? 'small' : 'default'">
    <div class="app-shell">
      <aside class="sidebar">
        <RouterLink to="/" class="brand" aria-label="框架首页"
          ><span class="brand-symbol"><AppIcon name="window" :size="24" /></span
          ><span class="brand-text"
            ><strong>DESKTOP</strong><small>FOUNDATION / 01</small></span
          ></RouterLink
        >
        <div class="nav-label">WORKSPACE</div>
        <nav aria-label="主导航">
          <RouterLink
            v-for="item in navigation"
            :key="item.name"
            :to="item.path"
            :title="item.label"
            :aria-label="item.label"
            class="nav-item"
            :class="{ active: route.name === item.name }"
            ><AppIcon :name="item.icon" /><span>{{ item.label }}</span
            ><span v-if="route.name === item.name" class="nav-dot"
          /></RouterLink>
        </nav>
        <div class="sidebar-note">
          <AppIcon name="shield" :size="22" /><strong>从基础开始，专注创造</strong>
          <p>通用能力就绪<br />业务由你定义</p>
        </div>
        <div class="sidebar-footer">
          <span class="status-dot" /><span>Electron · Vue · JavaScript</span>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div class="breadcrumb">
            <span>工作空间</span><span>/</span><strong>{{ route.meta.title }}</strong>
          </div>
          <div class="topbar-right">
            <span class="platform-badge">{{
              info?.platform === 'darwin'
                ? 'macOS'
                : info?.platform === 'win32'
                  ? 'Windows'
                  : 'DESKTOP'
            }}</span
            ><RouterLink to="/desktop" class="task-link"
              >任务 <span>{{ activeTasks }}</span></RouterLink
            >
          </div>
        </header>
        <div v-if="fatal" class="fatal-state" role="alert">
          <el-result icon="error" title="应用需要处理一个问题" :sub-title="fatal"
            ><template #extra
              ><el-button @click="initialize">重试显示</el-button
              ><el-button type="primary" @click="reload">重新加载</el-button></template
            ></el-result
          >
        </div>
        <div v-else-if="!ready" class="fatal-state" role="status" aria-label="正在初始化">
          <el-skeleton :rows="5" animated />
        </div>
        <RouterView v-else v-slot="{ Component }"><component :is="Component" /></RouterView>
        <footer class="statusbar">
          <span>业务无关的桌面应用基础框架</span
          ><span>v{{ info?.version || '1.0.0' }} <i /> {{ preferences.value.zoom * 100 }}%</span>
        </footer>
      </main>
    </div>
  </el-config-provider>
</template>
