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

// props：父级只读组件参数，字段默认值与事件责任见 props 说明。
const props = defineProps({
  /** 属性 modelValue：必填受控模型，修改发新对象，不直接修改父级。 */
  modelValue: { type: Object, required: true },
  /** 属性 fields：必填字段 schema，key/label/type/rules/options 描述控件；支持按 key 同名插槽扩展。 */
  fields: { type: Array, required: true },
  /** 属性 disabled：整表禁用开关，默认 false；不替代提交层同步动作锁。 */
  disabled: Boolean,
})
// emit：当前组件事件发布器，通知父级但不直接修改受控模型。
const emit = defineEmits(['update:modelValue'])
// form：当前 Element Plus 表单引用，挂载后支持 validate/clearValidate。
const form = ref()
/**
 * 以新对象提议单字段变更，保留其他草稿。
 * key：父级 schema 的字段键，更新时只替换对应标量。
 * value：字段提议的新值，合并为新 model 对象发给父级。
 */
function update(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
defineExpose({
  /**
   * 暴露表单异步校验，失败继续拒绝。
   */
  validate: () => form.value.validate(),
  /**
   * 只清除已挂载表单的校验提示，不重置草稿。
   */
  clearValidate: () => form.value?.clearValidate(),
})
</script>

<!-- 模板绑定：field 为当前字段 schema，option 为 select 的 label/value 选项。默认字段插槽 value 是当前值，update 回调参数 value 为拟写回的新字段值；$event 为底层控件提议的值，所有更新都交给父级。 -->
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
