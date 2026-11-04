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

// props：父级只读组件参数，字段默认值与事件责任见 props 说明。
const props = defineProps({
  /** 属性 modelValue：父级可见性，外部关闭取消旧确认，默认 false。 */
  modelValue: Boolean,
  /** 属性 title：必填标题及可访问名称。 */
  title: { type: String, required: true },
  /** 属性 submit：必填 submit(signal)，应先校验表单再真实提交，失败拒绝且保留草稿。 */
  submit: { type: Function, required: true },
  /** 属性 mode：dialog 或 drawer，默认 dialog，两者共用确认与取消契约。 */
  mode: {
    type: String,
    default: 'dialog',
    /**
     * 限制浮层 mode 为 dialog 或 drawer。
     * value：待校验的浮层模式，只允许 dialog/drawer。
     */
    validator: (value) => ['dialog', 'drawer'].includes(value),
  },
  /** 属性 confirmText：确认按钮文字，默认“保存”。 */
  confirmText: { type: String, default: '保存' },
})
// emit：当前组件事件发布器，通知父级但不直接修改受控模型。
const emit = defineEmits(['update:modelValue', 'success'])
// run：当前作用域异步动作入口，同一周期互斥并拦截取消后的迟到结果。
// cancel：取消本作用域当前动作并解除界面等待，不能撤销已经发生的外部写入。
// pending：当前动作等待状态 ref，初始 false，既驱动外观也同步拦截重复入口。
// error：当前公开失败或错误 ref，主动取消不追加失败提示。
const { run, cancel, pending, error } = useAsyncAction()
// component：由 mode 纯派生的 Element Plus 弹窗或抽屉名称。
const component = computed(
  /**
   * 由模式选择弹窗或抽屉组件，不复制开关状态。
   */
  () => (props.mode === 'drawer' ? 'el-drawer' : 'el-dialog'),
)
watch(
  /**
   * 读取父级可见性作为取消监听源。
   */
  () => props.modelValue,
  /**
   * 父级关闭浮层时取消正在执行的确认。
   * open：父级最新开关值，外部关闭立即取消确认周期。
   */
  (open) => {
    if (!open) cancel()
  },
)
/**
 * 先使旧确认失效，再通知父级关闭。
 */
function close() {
  // 先使旧动作失效再通知父组件关闭，避免关闭与下一次打开交错时收到上一轮成功。
  cancel()
  emit('update:modelValue', false)
}
/**
 * 同步拦截重复确认，成功发出结果并关闭，失败保留输入和错误。
 */
async function confirm() {
  if (pending.value || !props.modelValue) return
  try {
    // result：当前有效周期的操作结果，具体形状由被调用契约定义。
    const result = await run(props.submit)
    emit('success', result)
    close()
  } catch {
    /* 错误保留在弹窗，输入不丢失；取消时由控制器清理。 */
  }
}
</script>

<!-- 模板绑定：默认插槽 pending 是本次确认的等待布尔值；update:model-value 回调的 open 为底层浮层新开关值，只有 false 才走同一取消关闭路径。 -->
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
