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

// route：当前响应式路由，驱动导航选中态与页标题。
const route = useRoute()
// preferences：全应用非敏感偏好 store，初始化成功后才开放页面。
const preferences = usePreferences()
// tasks：全应用任务状态投影，根组件维护其订阅寿命。
const tasks = useTasks()
// info：公开应用诊断 ref，初始化前为 null。
const info = ref(null)
// fatal：初始化或子树渲染失败的公开文本，初始空串。
const fatal = ref('')
// ready：应用级初始化门禁，偏好和任务连接全部就绪才为 true。
const ready = ref(false)
// initializing：同步初始化锁，阻止重试创建多份订阅。
let initializing = false
// reload：重新加载当前 renderer 文档的恢复入口。
const reload =
  /**
   * 显式重新加载 renderer 文档以恢复根状态。
   */
  () => window.location.reload()
// activeTasks：状态为 running 的任务数，不包括已完成历史。
const activeTasks = computed(
  /**
   * 统计仍在执行的任务数。
   */
  () =>
    tasks.items.filter(
      /**
       * 判断任务是否处于 running。
       * task：当前被计数的公开任务快照。
       */
      (task) => task.status === 'running',
    ).length,
)
// disposeTheme：系统外观监听的清理函数，根组件销毁时执行。
const disposeTheme = preferences.observeSystemTheme()
// disposeTasks：当前任务订阅清理函数，重试前及销毁时执行。
let disposeTasks
// disposed：当前组件或控制器是否已销毁，初始 false，阻止迟到结果回填。
let disposed = false
/**
 * 根组件首次挂载或用户重试时执行；同步互斥，避免多份全局监听同时存活。
 * 初始化期间不开放设置控件，防止默认值编辑与迟到的磁盘快照互相覆盖。
 *
 * 同步互斥地初始化偏好、公开诊断和任务连接，失败切换根错误页。
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
    info.value = await unwrap(
      /**
       * 通过固定桥读取公开应用诊断。
       * api：沙盒 preload 的固定 desktop 能力接口。
       */
      (api) => api.info(),
    )
    if (info.value.storageWarning) ElMessage.warning(info.value.storageWarning)
    // dispose：刚建立的任务订阅清理函数，若根已销毁则立即调用。
    const dispose = await tasks.connect()
    if (disposed) dispose()
    else {
      disposeTasks = dispose
      ready.value = true
    }
  } catch (error) {
    // error：当前公开失败或错误 ref，主动取消不追加失败提示。

    fatal.value = error.message
  } finally {
    initializing = false
  }
}
onMounted(initialize)
onScopeDispose(
  /**
   * 标记根已销毁并解除主题与任务监听。
   */
  () => {
    disposed = true
    disposeTheme()
    disposeTasks?.()
  },
)
onErrorCaptured(
  /**
   * 捕获子树渲染失败，展示恢复入口并停止继续冒泡。
   * error：当前公开失败或错误 ref，主动取消不追加失败提示。
   */
  (error) => {
    // 阻止错误继续冒泡成空白页；错误页卸载原子树，其内部动作会按各自作用域取消。
    fatal.value = `界面加载失败：${error.message}`
    return false
  },
)
</script>

<!-- 模板绑定：item 为 navigation 的单个路由元数据，name 作稳定键，path 决定导航。RouterView 的 Component 是当前懒加载视图，初始化 ready 后才挂载。 -->
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
