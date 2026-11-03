<script setup>
import { useAsyncAction } from '../composables/useAsyncAction.js'

/**
 * 异步动作按钮，适用于一次点击对应一次可取消任务的操作。
 * Props：action(signal) 必填，可返回值或 Promise；其他按钮属性透传给 Element Plus。
 * Events：success(result) 仅在本轮动作成功时发出；error(error) 不包含主动取消。
 * 组件卸载会取消并拦截迟到结果；外部 action 的写入副作用仍需自行遵守 signal。
 * 用法：<AsyncButton :action="save" @success="reload" @error="showError">保存</AsyncButton>
 */
const props = defineProps({ action: { type: Function, required: true } })
const emit = defineEmits(['success', 'error'])
const { run, pending } = useAsyncAction()
async function execute() {
  // DOM disabled 在下一次渲染才生效，先同步挡住同一帧的第二次点击与成功回调。
  if (pending.value) return
  try {
    const result = await run(props.action)
    emit('success', result)
  } catch (error) {
    if (error.name !== 'AbortError' && error.code !== 'CANCELLED') emit('error', error)
  }
}
</script>

<template>
  <el-button :loading="pending" :disabled="pending" @click="execute"><slot /></el-button>
</template>
