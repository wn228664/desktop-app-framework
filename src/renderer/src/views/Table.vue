<script setup>
/**
 * 本地表格示例：source 是框架能力目录，query 仅在 SearchForm 提交后更新。
 * source 与已选行都只活在当前页面，没有接口、持久化或业务权限；远程项目可把 items 换成 loader。
 * 外层 FrameworkPage 关闭内容滚动，表格正文与超宽分页分别管理自己的滚动容器。
 */
import { computed, ref } from 'vue'
import FrameworkPage from '../components/FrameworkPage.vue'
import SearchForm from '../components/SearchForm.vue'
import DataTable from '../components/DataTable.vue'

const query = ref({})
const selection = ref([])
const source = [
  ['AsyncButton', '交互组件', '异步互斥与生命周期取消'],
  ['ActionDialog', '交互组件', '弹窗与抽屉的提交契约'],
  ['SchemaForm', '交互组件', '表单校验和字段插槽'],
  ['SearchForm', '交互组件', '条件快照与显式搜索'],
  ['DataTable', '交互组件', '分页、排序和列显隐'],
  ['StateView', '交互组件', '加载、空态和错误反馈'],
  ['FileUpload', '文件能力', '授权文件与上传取消'],
  ['FileGrants', '文件能力', '文件 ID 与窗口权限隔离'],
  ['AtomicWrite', '文件能力', '同目录临时文件与原子替换'],
  ['ReadText', '文件能力', '有界 UTF-8 文本读取'],
  ['Request', '基础封装', '相对路径、超时和主动取消'],
  ['Tasks', '基础封装', '进度事件与任务归属'],
  ['Preferences', '基础封装', '串行持久化和设置白名单'],
  ['Credentials', '基础封装', '内存令牌和系统加密'],
  ['Updates', '桌面能力', '显式检查、下载和安装'],
  ['Clipboard', '桌面能力', '用户触发的读写操作'],
  ['Notification', '桌面能力', '原生系统通知'],
  ['Window', '桌面能力', '窗口恢复和多屏边界'],
  ['Tray', '桌面能力', '按需启用的托盘模式'],
  ['Theme', '基础封装', '明暗主题与跟随系统'],
  ['Format', '工具函数', '字节和本地时间格式化'],
  ['Validation', '工具函数', '参数与可信 URL 检查'],
  ['AsyncAction', '工具函数', '单次动作与过期结果隔离'],
  ['DebouncedRef', '工具函数', '输入防抖和卸载清理'],
].map(([name, category, description], index) => ({
  id: index + 1,
  name,
  category,
  description,
  language: 'JavaScript',
}))
const filtered = computed(() =>
  source.filter(
    (row) =>
      (!query.value.keyword ||
        `${row.name} ${row.description}`
          .toLowerCase()
          .includes(query.value.keyword.trim().toLowerCase())) &&
      (!query.value.category || row.category === query.value.category),
  ),
)
const fields = [
  { key: 'keyword', label: '名称或说明', placeholder: '搜索框架能力' },
  {
    key: 'category',
    label: '分类',
    type: 'select',
    options: [...new Set(source.map((row) => row.category))].map((value) => ({
      label: value,
      value,
    })),
  },
]
const columns = [
  { prop: 'name', label: '能力名称', minWidth: 170, sortable: true },
  { prop: 'category', label: '分类', width: 120 },
  { prop: 'description', label: '说明', minWidth: 240 },
  { prop: 'language', label: '语言', width: 120 },
]
</script>

<template>
  <FrameworkPage
    class="table-page"
    title="表格与搜索"
    description="本地框架能力清单。搜索、表格、分页各有清晰边界。"
    :scroll="false"
  >
    <section class="panel table-panel">
      <SearchForm :fields="fields" @search="query = $event" />
      <div class="table-divider" />
      <DataTable
        :items="filtered"
        :columns="columns"
        selectable
        @selection-change="selection = $event"
        ><template #toolbar
          ><span v-if="selection.length" class="selection-note"
            >已选择 {{ selection.length }} 项</span
          ></template
        ><template #category="{ value }"
          ><el-tag effect="plain" size="small">{{ value }}</el-tag></template
        ></DataTable
      >
    </section>
  </FrameworkPage>
</template>
