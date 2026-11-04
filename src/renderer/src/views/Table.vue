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

// query：SearchForm 显式提交的条件快照 ref，输入过程不立即查询。
const query = ref({})
// selection：当前可见页选中行 ref，不跨页或持久化。
const selection = ref([])
// source：本地能力目录，经稳定一基 id 转成行对象。
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
].map(
  /**
   * 把静态能力条目转换成带稳定示例 id 的行。
   * name：当前能力条目的公开名称。
   * category：当前能力条目的中性分类。
   * description：当前能力条目的说明文字。
   * index：能力目录零基序号，只用于生成固定示例 id。
   */
  ([name, category, description], index) => ({
    id: index + 1,
    name,
    category,
    description,
    language: 'JavaScript',
  }),
)
// filtered：按已提交关键字和分类筛选的本地数据派生集合。
const filtered = computed(
  /**
   * 从已提交条件派生筛选结果，不修改 source。
   */
  () =>
    source.filter(
      /**
       * 按关键字和分类匹配当前候选行。
       * row：当前能力行，按名称/说明或分类匹配。
       */
      (row) =>
        (!query.value.keyword ||
          `${row.name} ${row.description}`
            .toLowerCase()
            .includes(query.value.keyword.trim().toLowerCase())) &&
        (!query.value.category || row.category === query.value.category),
    ),
)
// fields：搜索字段 schema，分类选项由本地目录去重生成。
const fields = [
  { key: 'keyword', label: '名称或说明', placeholder: '搜索框架能力' },
  {
    key: 'category',
    label: '分类',
    type: 'select',
    options: [
      ...new Set(
        source.map(
          /**
           * 提取行分类以构造去重的筛选项。
           * row：当前能力行，按名称/说明或分类匹配。
           */
          (row) => row.category,
        ),
      ),
    ].map(
      /**
       * 把分类名称转换为显式 label/value 选项。
       * value：当前去重后的分类名称，同时作为选项 label/value。
       */
      (value) => ({
        label: value,
        value,
      }),
    ),
  },
]
// columns：表格列 schema，名称允许排序，说明列可伸展。
const columns = [
  { prop: 'name', label: '能力名称', minWidth: 170, sortable: true },
  { prop: 'category', label: '分类', width: 120 },
  { prop: 'description', label: '说明', minWidth: 240 },
  { prop: 'language', label: '语言', width: 120 },
]
</script>

<!-- 模板绑定：category 插槽的 value 是当前行原始分类文本，转发给 el-tag；selection-change 的 $event 是当前可见页选中行。 -->
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
