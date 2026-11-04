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
// props：父级只读组件参数，字段默认值与事件责任见 props 说明。
const props = defineProps({
  /** 属性 columns：必填列 schema；prop 为字段和插槽键，formatter(value,row) 只做展示，sortable 开启排序。 */
  columns: { type: Array, required: true },
  /** 属性 items：本地数据数组，每实例默认独立空数组；存在 loader 时优先使用远程结果。 */
  items: {
    type: Array,

    /**
     * 每实例创建独立空数据数组。
     */
    default: () => [],
  },
  /** 属性 loader：可选远程加载器，接收 {page,pageSize,query,sort,signal} 并返回 {rows,total}；默认 null。 */
  loader: { type: Function, default: null },
  /** 属性 query：已经提交的筛选快照，每实例默认独立空对象，输入草稿应在父层隔离。 */
  query: {
    type: Object,

    /**
     * 每实例创建独立空查询对象。
     */
    default: () => ({}),
  },
  /** 属性 rowKey：非空唯一行键的属性名，默认 id；缺失或页内重复拒绝结果。 */
  rowKey: { type: String, default: 'id' },
  /** 属性 selectable：是否显示页内行选择，默认 false；条件或页码变更清空选择。 */
  selectable: Boolean,
})
// emit：当前组件事件发布器，通知父级但不直接修改受控模型。
const emit = defineEmits(['selection-change', 'loaded'])
// table：当前 Element Plus 表格实例，用于清除页内行选择。
const table = ref()
// page：一基页码 ref，初始 1，条件改变回第一页。
const page = ref(1)
// pageSize：每页行数 ref，初始 10，变更触发重载。
const pageSize = ref(10)
// rows：当前已接收的页内行集合，初值空数组。
const rows = ref([])
// total：当前数据源声明的非负总行数 ref。
const total = ref(0)
// sort：当前排序字段和方向的 ref，初值空对象表示未排序。
const sort = ref({})
// hidden：用户隐藏的列 prop 集合，仅影响显示不修改列 schema。
const hidden = ref([])
// visible：按 hidden 过滤后的列 schema，保持父级列顺序。
const visible = computed(
  /**
   * 根据用户隐藏列集合派生可见列。
   */
  () =>
    props.columns.filter(
      /**
       * 仅保留未在 hidden 中的列。
       * column：当前父级列定义，prop 是显示与单元格插槽的稳定键。
       */
      (column) => !hidden.value.includes(column.prop),
    ),
)
// run：当前作用域异步动作入口，同一周期互斥并拦截取消后的迟到结果。
// cancel：取消本作用域当前动作并解除界面等待，不能撤销已经发生的外部写入。
// pending：当前动作等待状态 ref，初始 false，既驱动外观也同步拦截重复入口。
// error：当前公开失败或错误 ref，主动取消不追加失败提示。
const { run, cancel, pending, error } = useAsyncAction()
// revision：加载版本，条件变更和销毁使旧加载结果失效。
let revision = 0

/**
 * 使旧加载失效，清理选择，读取并验证新数据后交付 loaded。
 */
async function reload() {
  // 请求版本与 AbortSignal 双重约束：即使 loader 忽略 signal，旧响应也不能覆盖新条件。
  // ticket：本次加载捕获的版本，交付前必须与 revision 一致。
  const ticket = ++revision
  cancel()
  table.value?.clearSelection()
  emit('selection-change', [])
  try {
    // result：当前有效周期的操作结果，具体形状由被调用契约定义。
    const result = await run(
      /**
       * 根据 loader 是否存在选择远程契约或本地排序分页。
       * signal：当前动作 AbortSignal，异步完成后提交结果或副作用前须复验。
       */
      async (signal) => {
        if (props.loader)
          return props.loader({
            page: page.value,
            pageSize: pageSize.value,
            query: { ...props.query },
            sort: { ...sort.value },
            signal,
          })
        // data：本地数据浅拷贝，只在副本排序和分页，不修改父级 items。
        const data = [...props.items]
        if (sort.value.prop && sort.value.order) {
          // direction：本地排序方向乘数，ascending 为 1，否则 -1。
          const direction = sort.value.order === 'ascending' ? 1 : -1
          data.sort(
            /**
             * 按原字段值和方向比较两行，不推断业务格式。
             * a：比较器左侧行，读取同一排序字段的原值。
             * b：比较器右侧行，读取同一排序字段的原值。
             */
            (a, b) => compareValues(a[sort.value.prop], b[sort.value.prop]) * direction,
          )
        }
        return {
          rows: data.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
          total: data.length,
        }
      },
    )
    if (ticket !== revision) return
    if (
      !result ||
      !Array.isArray(result.rows) ||
      !Number.isInteger(result.total) ||
      result.total < 0 ||
      result.rows.some(
        /**
         * 检查行对象及稳定行键是否缺失。
         * row：当前候选行，必须提供唯一且非空的 rowKey。
         */
        (row) =>
          !row ||
          typeof row !== 'object' ||
          row[props.rowKey] === undefined ||
          row[props.rowKey] === null ||
          row[props.rowKey] === '',
      ) ||
      new Set(
        result.rows.map(
          /**
           * 提取稳定行键用于检测页内重复。
           * row：当前候选行，必须提供唯一且非空的 rowKey。
           */
          (row) => row[props.rowKey],
        ),
      ).size !== result.rows.length
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
    // failure：当前捕获的操作失败，仅向所属组件或页面反馈公开提示。

    if (ticket === revision && failure.name !== 'AbortError' && failure.code !== 'CANCELLED')
      error.value = failure
  }
}
/**
 * 提交新排序并确保只触发一次加载。
 * value：Element Plus 排序事件，提供 prop 和 order。
 */
function changeSort(value) {
  // 页码不变时手动加载；页码变化时只交给 watch，避免同一次排序发出两次远程请求。
  sort.value = { prop: value.prop, order: value.order }
  if (page.value !== 1) page.value = 1
  else void reload()
}
watch(
  /**
   * 观察已提交 query、数据源和加载器变化。
   */
  () => [props.query, props.items, props.loader],
  /**
   * 条件改变回到第一页，由单一入口负责重载。
   */
  () => {
    if (page.value !== 1) page.value = 1
    else void reload()
  },
  { deep: true, immediate: true },
)
watch(
  [page, pageSize],
  /**
   * 页码或页容量变更后重载当前条件。
   */
  () => {
    void reload()
  },
)
onScopeDispose(
  /**
   * 销毁时推进版本，让忽略 signal 的旧结果也无法回填。
   */
  () => {
    revision++
  },
)
defineExpose({
  reload,

  /**
   * 暴露只清理页内行选择的命令。
   */
  clearSelection: () => table.value?.clearSelection(),
})
</script>

<!-- 模板绑定：列显隐回调 checked 为是否显示，column 为当前列 schema，内层 item 为已隐藏列的 prop。单元格 scope.row 是当前页行对象，插槽 row/value 分别交付该行及列原值；column.formatter(value,row) 只格式化展示。selection-change 的 $event 是本页行数组，sort-change 交给脚本处理。 -->
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
