<script setup>
/**
 * 框架入口说明页，只读取应用版本/平台信息并导航到通用能力演示。
 * modules 是本地能力说明，不代表真实后端、在线更新或外部服务已接通；接入具体产品时可整体替换此页。
 */
import { ref, onMounted } from 'vue'
import FrameworkPage from '../components/FrameworkPage.vue'
import AppIcon from '../components/AppIcon.vue'
import { unwrap } from '../core/desktop.js'
const info = ref(null)
const error = ref('')
onMounted(async () => {
  try {
    info.value = await unwrap((api) => api.info())
  } catch (failure) {
    error.value = failure.message
  }
})
const modules = [
  {
    icon: 'layers',
    title: '通用交互组件',
    body: '表单、弹窗、抽屉与状态反馈。异步提交、失败保留、取消与卸载清理内置。',
    path: '/components',
    tags: ['Element Plus', '可组合'],
  },
  {
    icon: 'table',
    title: '表格与条件搜索',
    body: '本地与远程数据、分页、排序、选择与列配置。搜索条件独立提交，旧请求自动失效。',
    path: '/table',
    tags: ['容器滚动', '稳定行键'],
  },
  {
    icon: 'window',
    title: '桌面原生能力',
    body: '原生文件授权、剪贴板、通知、传输任务与更新。通过固定桥接接口使用系统能力。',
    path: '/desktop',
    tags: ['安全 IPC', '可取消'],
  },
  {
    icon: 'settings',
    title: '可持续的应用基础',
    body: '主题、密度、缩放、托盘、窗口恢复与本地偏好。macOS 和 Windows 独立打包。',
    path: '/settings',
    tags: ['持久化', '双平台'],
  },
]
</script>

<template>
  <FrameworkPage title="框架概览" description="一个清晰、克制、可持续扩展的桌面起点。">
    <div class="overview-stack">
      <section class="hero-panel">
        <div class="hero-copy">
          <span class="eyebrow">BUILD SOMETHING THAT MATTERS</span>
          <h2>基础已备好。<br /><span>让想法成为桌面应用。</span></h2>
          <p>用成熟组件构建界面，用清晰边界连接系统。<br />从这里开始，扩展你的下一款应用。</p>
          <RouterLink to="/components" class="hero-link"
            >探索通用组件 <AppIcon name="arrow" :size="18"
          /></RouterLink>
        </div>
        <div class="architecture-art" aria-hidden="true">
          <div class="art-top"><span /><span /><span /></div>
          <div class="art-layout">
            <div class="art-sidebar"><i /><i /><i /></div>
            <div class="art-content">
              <div class="art-line" />
              <div class="art-cards"><i /><i /><i /></div>
              <div class="art-table"><i /><i /><i /></div>
            </div>
          </div>
          <div class="art-chip">
            <AppIcon name="check" :size="15" /> JavaScript · No business code
          </div>
        </div>
      </section>
      <section class="foundation-strip" aria-label="基础配置">
        <div>
          <small>应用运行时</small><strong>Electron {{ info?.electron || '45' }}</strong>
        </div>
        <div><small>交互与组件</small><strong>Vue 3 + Element Plus</strong></div>
        <div><small>语言与构建</small><strong>JavaScript / Vite</strong></div>
        <div><small>目标平台</small><strong>macOS & Windows</strong></div>
      </section>
      <div class="section-heading">
        <h2>基础能力</h2>
        <span>通用封装 · 按需扩展</span>
      </div>
      <div class="module-grid">
        <RouterLink
          v-for="module in modules"
          :key="module.path"
          :to="module.path"
          class="module-card"
          ><div class="module-card-top">
            <span class="module-icon"><AppIcon :name="module.icon" :size="23" /></span
            ><AppIcon name="arrow" :size="18" />
          </div>
          <h3>{{ module.title }}</h3>
          <p>{{ module.body }}</p>
          <div class="tag-row">
            <span v-for="tag in module.tags" :key="tag">{{ tag }}</span>
          </div></RouterLink
        >
      </div>
      <el-alert v-if="error" type="error" :title="error" :closable="false" />
      <div class="overview-note">
        <AppIcon name="shield" :size="18" />
        <p>
          框架演示仅使用本地通用示例。请求、上传、下载与在线更新需要接入真实配置；未配置时明确提示。
        </p>
      </div>
    </div>
  </FrameworkPage>
</template>
