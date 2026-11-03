import { createApp } from 'vue'
import { createPinia } from 'pinia'
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElConfigProvider,
  ElDialog,
  ElDrawer,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElLoading,
  ElOption,
  ElPagination,
  ElPopover,
  ElProgress,
  ElResult,
  ElSegmented,
  ElSelect,
  ElSkeleton,
  ElSwitch,
  ElTable,
  ElTableColumn,
  ElTag,
} from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/app.css'
import './styles/responsive.css'
import App from './App.vue'
import router from './router.js'

/**
 * renderer 唯一装配入口：Pinia → Router → 当前会用到的 Element Plus 组件 → App。
 * 新增基础控件时按需补充注册；动态字符串使用的 Dialog/Drawer 也必须注册，不能只靠模板静态扫描。
 * 基础样式先于响应式样式加载，否则后定义的默认布局会覆盖窄窗口规则。
 */
const app = createApp(App)
app.use(createPinia()).use(router)
// 只注册当前基础组件；完整 UI 库可继续按需导入，避免打包全部组件脚本。
for (const component of [
  ElAlert,
  ElButton,
  ElCheckbox,
  ElConfigProvider,
  ElDialog,
  ElDrawer,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElLoading,
  ElOption,
  ElPagination,
  ElPopover,
  ElProgress,
  ElResult,
  ElSegmented,
  ElSelect,
  ElSkeleton,
  ElSwitch,
  ElTable,
  ElTableColumn,
  ElTag,
])
  app.use(component)
app.mount('#app')
