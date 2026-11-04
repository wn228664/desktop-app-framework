<script setup>
/**
 * 显式提交的搜索草稿。输入过程不直接修改父级查询条件，按搜索/重置后才发出快照。
 * Props：fields 声明 text/select 字段；modelValue 默认 {}；loading 控制搜索/重置按钮状态。
 * Events：update:modelValue(snapshot)、search(snapshot)；重置额外发 reset，并提交一次空查询。
 * 空串/null/undefined 会移除，0 与 false 保留；组件不会猜测是否应 trim、合并范围或转换接口参数。
 * Slots：默认插槽放搜索操作区的扩展控件。远程请求取消与结果时序由表格/接入层处理。
 * 用法：<SearchForm :fields="fields" @search="query = $event" />
 */
import { reactive, watch } from 'vue'
import { compactQuery } from '../core/format.js'

// props：父级只读组件参数，字段默认值与事件责任见 props 说明。
const props = defineProps({
  /** 属性 fields：必填筛选 schema，使用 key/label/type/options，文本输入默认最大 100 字符。 */
  fields: { type: Array, required: true },
  /** 属性 modelValue：已提交模型，每实例默认独立空对象，输入先保存在本组件草稿。 */
  modelValue: {
    type: Object,

    /**
     * 每实例创建独立的空搜索模型。
     */
    default: () => ({}),
  },
  /** 属性 loading：控制搜索/重置等待状态，默认 false；数据请求由父级管理。 */
  loading: Boolean,
})
// emit：当前组件事件发布器，通知父级但不直接修改受控模型。
const emit = defineEmits(['update:modelValue', 'search', 'reset'])
// values：当前搜索草稿 reactive 对象，输入时不改父级查询。
const values = reactive({})
watch(
  /**
   * 观察外部受控搜索模型。
   */
  () => props.modelValue,
  /**
   * 先删除旧键，再把父级新模型同步到草稿。
   * value：父级提供的最新受控搜索模型，只同步到本地草稿。
   */
  (value) => {
    // key：旧草稿中的键，同步外部模型或重置时逐项删除。
    for (const key of Object.keys(values)) delete values[key]
    Object.assign(values, value)
  },
  { immediate: true, deep: true },
)
/**
 * 创建独立条件快照并通知 model 更新与显式搜索。
 */
function search() {
  // 发新对象，保证表格拿到的是本次提交条件；继续输入不会无意触发查询。
  // snapshot：清除空值后的本次提交条件新对象，0/false 保留。
  const snapshot = compactQuery({ ...values })
  emit('update:modelValue', snapshot)
  emit('search', snapshot)
}
/**
 * 删除全部旧草稿键并发出一次空条件搜索及 reset。
 */
function reset() {
  // 删除草稿中的旧键，不能只赋 {}，否则 reactive 对象仍保留上一次动态字段。
  // key：旧草稿中的键，同步外部模型或重置时逐项删除。
  for (const key of Object.keys(values)) delete values[key]
  emit('update:modelValue', {})
  emit('reset')
  emit('search', {})
}
</script>

<!-- 模板绑定：field 为当前筛选 schema，option 为该字段的 label/value 选项；values 是未提交草稿，只有搜索/重置才通知父级。 -->
<template>
  <el-form class="search-form" label-position="top" @submit.prevent="search">
    <el-form-item v-for="field in fields" :key="field.key" :label="field.label">
      <el-select
        v-if="field.type === 'select'"
        v-model="values[field.key]"
        clearable
        :placeholder="field.placeholder || '全部'"
        :aria-label="field.label"
        ><el-option
          v-for="option in field.options"
          :key="option.value"
          :label="option.label"
          :value="option.value"
      /></el-select>
      <el-input
        v-else
        v-model="values[field.key]"
        clearable
        :placeholder="field.placeholder || '请输入'"
        :aria-label="field.label"
        :maxlength="field.maxlength || 100"
      />
    </el-form-item>
    <div class="search-actions">
      <el-button type="primary" native-type="submit" :loading="loading">搜索</el-button
      ><el-button :disabled="loading" @click="reset">重置</el-button><slot />
    </div>
  </el-form>
</template>
