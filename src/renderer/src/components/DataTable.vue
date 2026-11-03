<script setup>
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useAsyncAction } from '../composables/useAsyncAction.js'
import StateView from './StateView.vue'
import { compareValues } from '../core/table.js'

/**
 * 有界高度的数据表格。父容器必须有确定高度与 min-height:0，不能靠页面整体滚动展示全部行。
 * Props：columns 必填；items 为本地数组；loader 为可选远程函数，存在时优先于 items。
 * query 是已提交筛选快照；rowKey 默认 id，要求每行非空且唯一；selectable 默认关闭。
 * loader({page,pageSize,query,sort,signal}) 返回 {rows,total}，page 从 1 开始，total 为非负整数。
 * columns 的 formatter(value,row) 在显示时调用；sortable 开启本地类型排序或向远端传递 sort。
 * Events：loaded({rows,total}) 表示本轮数据已接收；selection-change(rows) 表示当前可见页选择状态。
 * Slots：toolbar 放通用操作，各列可用 prop 同名插槽接收 {row,value}。
 * Expose：reload() 重新加载当前条件，clearSelection() 撤销选择；两者不执行任何业务写入。
 * 用法：<DataTable :columns="columns" :loader="loadRows" :query="query" row-key="id" />
 */
const props = defineProps({
  columns: { type: Array, required: true },
  items: { type: Array, default: () => [] },
  loader: { type: Function, default: null },
  query: { type: Object, default: () => ({}) },
  rowKey: { type: String, default: 'id' },
  selectable: Boolean,
})
const emit = defineEmits(['selection-change', 'loaded'])
const table = ref()
const page = ref(1)
const pageSize = ref(10)
const rows = ref([])
const total = ref(0)
const sort = ref({})
const hidden = ref([])
const visible = computed(() =>
  props.columns.filter((column) => !hidden.value.includes(column.prop)),
)
const { run, cancel, pending, error } = useAsyncAction()
let revision = 0

async function reload() {
  // 请求版本与 AbortSignal 双重约束：即使 loader 忽略 signal，旧响应也不能覆盖新条件。
  const ticket = ++revision
  cancel()
  table.value?.clearSelection()
  emit('selection-change', [])
  try {
    const result = await run(async (signal) => {
      if (props.loader)
        return props.loader({
          page: page.value,
          pageSize: pageSize.value,
          query: { ...props.query },
          sort: { ...sort.value },
          signal,
        })
      const data = [...props.items]
      if (sort.value.prop && sort.value.order) {
        const direction = sort.value.order === 'ascending' ? 1 : -1
        data.sort((a, b) => compareValues(a[sort.value.prop], b[sort.value.prop]) * direction)
      }
      return {
        rows: data.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
        total: data.length,
      }
    })
    if (ticket !== revision) return
    if (
      !result ||
      !Array.isArray(result.rows) ||
      !Number.isInteger(result.total) ||
      result.total < 0 ||
      result.rows.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          row[props.rowKey] === undefined ||
          row[props.rowKey] === null ||
          row[props.rowKey] === '',
      ) ||
      new Set(result.rows.map((row) => row[props.rowKey])).size !== result.rows.length
    ) {
      throw new Error('表格数据必须提供唯一行键以及合法的 rows、total')
    }
    if (page.value > Math.max(1, Math.ceil(result.total / pageSize.value))) {
      // 删除末页最后一行等情况会使当前页失效，回到有效页后由 watch 再加载。
      page.value = Math.max(1, Math.ceil(result.total / pageSize.value))
      return
    }
    rows.value = result.rows
    total.value = result.total
    emit('loaded', result)
  } catch (failure) {
    if (ticket === revision && failure.name !== 'AbortError' && failure.code !== 'CANCELLED')
      error.value = failure
  }
}
function changeSort(value) {
  // 页码不变时手动加载；页码变化时只交给 watch，避免同一次排序发出两次远程请求。
  sort.value = { prop: value.prop, order: value.order }
  if (page.value !== 1) page.value = 1
  else void reload()
}
watch(
  () => [props.query, props.items, props.loader],
  () => {
    if (page.value !== 1) page.value = 1
    else void reload()
  },
  { deep: true, immediate: true },
)
watch([page, pageSize], () => {
  void reload()
})
onScopeDispose(() => {
  revision++
})
defineExpose({ reload, clearSelection: () => table.value?.clearSelection() })
</script>

<template>
  <section class="data-table" aria-label="数据表格" :aria-busy="pending">
    <div class="table-toolbar">
      <span class="muted">共 {{ total }} 项</span>
      <div class="toolbar-actions">
        <slot name="toolbar" /><el-button :disabled="pending" @click="reload">刷新</el-button
        ><el-popover placement="bottom-end" trigger="click" width="200"
          ><template #reference><el-button>显示列</el-button></template>
          <div class="column-options">
            <el-checkbox
              v-for="column in columns"
              :key="column.prop"
              :model-value="!hidden.includes(column.prop)"
              @change="
                (checked) =>
                  (hidden = checked
                    ? hidden.filter((item) => item !== column.prop)
                    : [...hidden, column.prop])
              "
              >{{ column.label }}</el-checkbox
            >
          </div></el-popover
        >
      </div>
    </div>
    <div class="table-content">
      <StateView :error="error" @retry="reload">
        <el-table
          ref="table"
          v-loading="pending"
          :data="rows"
          :row-key="rowKey"
          height="100%"
          stripe
          @selection-change="emit('selection-change', $event)"
          @sort-change="changeSort"
        >
          <el-table-column v-if="selectable" type="selection" width="44" />
          <el-table-column
            v-for="column in visible"
            :key="column.prop"
            v-bind="column"
            :sortable="column.sortable ? 'custom' : false"
            show-overflow-tooltip
            ><template #default="scope"
              ><slot :name="column.prop" :row="scope.row" :value="scope.row[column.prop]"
                ><span>{{
                  column.formatter
                    ? column.formatter(scope.row[column.prop], scope.row)
                    : scope.row[column.prop]
                }}</span></slot
              ></template
            ></el-table-column
          >
          <template #empty><el-empty description="没有符合条件的内容" :image-size="72" /></template>
        </el-table>
      </StateView>
    </div>
    <footer class="table-pagination">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="prev, pager, next, sizes"
        :pager-count="5"
        background
      />
    </footer>
  </section>
</template>
