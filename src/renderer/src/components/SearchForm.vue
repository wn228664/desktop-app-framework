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

const props = defineProps({
  fields: { type: Array, required: true },
  modelValue: { type: Object, default: () => ({}) },
  loading: Boolean,
})
const emit = defineEmits(['update:modelValue', 'search', 'reset'])
const values = reactive({})
watch(
  () => props.modelValue,
  (value) => {
    for (const key of Object.keys(values)) delete values[key]
    Object.assign(values, value)
  },
  { immediate: true, deep: true },
)
function search() {
  // 发新对象，保证表格拿到的是本次提交条件；继续输入不会无意触发查询。
  const snapshot = compactQuery({ ...values })
  emit('update:modelValue', snapshot)
  emit('search', snapshot)
}
function reset() {
  // 删除草稿中的旧键，不能只赋 {}，否则 reactive 对象仍保留上一次动态字段。
  for (const key of Object.keys(values)) delete values[key]
  emit('update:modelValue', {})
  emit('reset')
  emit('search', {})
}
</script>

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
