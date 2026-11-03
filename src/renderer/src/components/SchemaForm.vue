<script setup>
/**
 * 简单字段表单，数据所有权始终在父组件。
 * Props：modelValue/fields 必填，disabled 控制整表交互；fields 使用 key/label/type/rules/options 等声明。
 * 支持 text、textarea、select、switch；复杂日期/联动/自定义控件通过字段 key 同名插槽接入。
 * Slots：{value,update} 中 update(next) 发出新的浅层 model 对象，不直接修改 props。
 * Expose：挂载后 await validate()，失败会拒绝 Promise；clearValidate() 只清除提示，不重置草稿。
 * 本组件不发送请求、不判断业务成功、不在失败后丢弃输入；提交与回滚由父组件负责。
 * 用法：<SchemaForm ref="form" v-model="draft" :fields="fields" />
 */
import { ref } from 'vue'

const props = defineProps({
  modelValue: { type: Object, required: true },
  fields: { type: Array, required: true },
  disabled: Boolean,
})
const emit = defineEmits(['update:modelValue'])
const form = ref()
function update(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
defineExpose({
  validate: () => form.value.validate(),
  clearValidate: () => form.value?.clearValidate(),
})
</script>

<template>
  <el-form ref="form" :model="modelValue" :disabled="disabled" label-position="top" @submit.prevent>
    <el-form-item
      v-for="field in fields"
      :key="field.key"
      :label="field.label"
      :prop="field.key"
      :rules="field.rules"
    >
      <slot
        :name="field.key"
        :value="modelValue[field.key]"
        :update="(value) => update(field.key, value)"
      >
        <el-select
          v-if="field.type === 'select'"
          :model-value="modelValue[field.key]"
          :aria-label="field.label"
          @update:model-value="update(field.key, $event)"
          ><el-option v-for="option in field.options" :key="option.value" v-bind="option"
        /></el-select>
        <el-switch
          v-else-if="field.type === 'switch'"
          :model-value="modelValue[field.key]"
          :aria-label="field.label"
          @update:model-value="update(field.key, $event)"
        />
        <el-input
          v-else
          :model-value="modelValue[field.key]"
          :type="field.type === 'textarea' ? 'textarea' : 'text'"
          :rows="field.type === 'textarea' ? 3 : undefined"
          :maxlength="field.maxlength || 200"
          :placeholder="field.placeholder"
          :aria-label="field.label"
          @update:model-value="update(field.key, $event)"
        />
      </slot>
      <div v-if="field.help" class="field-help">{{ field.help }}</div>
    </el-form-item>
  </el-form>
</template>
