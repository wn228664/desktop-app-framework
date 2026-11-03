<script setup>
import { computed, watch } from 'vue'
import { useAsyncAction } from '../composables/useAsyncAction.js'

/**
 * 共用提交契约的弹窗/抽屉，草稿由父组件持有，不在内部偷偷创建或清空业务表单。
 * Props：modelValue 控制开关；title/submit(signal) 必填；mode 默认 dialog，可选 drawer；confirmText 默认保存。
 * Events：update:modelValue(false) 请求关闭；success(result) 返回本次提交结果。
 * Slots：默认插槽接收 pending，可用于禁用草稿控件。submit 内应先调用表单 validate，再执行真实保存。
 * 失败保持打开并显示错误；进行中不接受遮罩/Escape 误关闭，但用户可显式取消。
 * 用法：<ActionDialog v-model="open" title="编辑内容" :submit="save"><SchemaForm ... /></ActionDialog>
 */

const props = defineProps({
  modelValue: Boolean,
  title: { type: String, required: true },
  submit: { type: Function, required: true },
  mode: {
    type: String,
    default: 'dialog',
    validator: (value) => ['dialog', 'drawer'].includes(value),
  },
  confirmText: { type: String, default: '保存' },
})
const emit = defineEmits(['update:modelValue', 'success'])
const { run, cancel, pending, error } = useAsyncAction()
const component = computed(() => (props.mode === 'drawer' ? 'el-drawer' : 'el-dialog'))
watch(
  () => props.modelValue,
  (open) => {
    if (!open) cancel()
  },
)
function close() {
  // 先使旧动作失效再通知父组件关闭，避免关闭与下一次打开交错时收到上一轮成功。
  cancel()
  emit('update:modelValue', false)
}
async function confirm() {
  if (pending.value || !props.modelValue) return
  try {
    const result = await run(props.submit)
    emit('success', result)
    close()
  } catch {
    /* 错误保留在弹窗，输入不丢失；取消时由控制器清理。 */
  }
}
</script>

<template>
  <component
    :is="component"
    :model-value="modelValue"
    :title="title"
    width="min(560px, calc(100vw - 48px))"
    size="min(560px, 94vw)"
    class="action-dialog"
    :close-on-click-modal="!pending"
    :close-on-press-escape="!pending"
    destroy-on-close
    @update:model-value="
      (open) => {
        if (!open) close()
      }
    "
  >
    <div class="dialog-content">
      <slot :pending="pending" /><el-alert
        v-if="error"
        type="error"
        :title="error.message"
        :closable="false"
        show-icon
      />
    </div>
    <template #footer
      ><el-button @click="close">{{ pending ? '取消操作' : '取消' }}</el-button
      ><el-button type="primary" :loading="pending" :disabled="pending" @click="confirm">{{
        confirmText
      }}</el-button></template
    >
  </component>
</template>
