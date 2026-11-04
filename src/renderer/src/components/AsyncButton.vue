<script setup>
import { useAsyncAction } from '../composables/useAsyncAction.js'

/**
 * 异步动作按钮，适用于一次点击对应一次可取消任务的操作。
 * Props：action(signal) 必填，可返回值或 Promise；其他按钮属性透传给 Element Plus。
 * Events：success(result) 仅在本轮动作成功时发出；error(error) 不包含主动取消。
 * 组件卸载会取消并拦截迟到结果；外部 action 的写入副作用仍需自行遵守 signal。
 * 用法：<AsyncButton :action="save" @success="reload" @error="showError">保存</AsyncButton>
 */
// props：父级只读组件参数，字段默认值与事件责任见 props 说明。
const props = defineProps({
  /** 属性 action：必填 action(signal)，成功发 success，主动取消不发 error；外部写入须遵守 signal。 */
  action: { type: Function, required: true },
})
// emit：当前组件事件发布器，通知父级但不直接修改受控模型。
const emit = defineEmits(['success', 'error'])
// run：当前作用域异步动作入口，同一周期互斥并拦截取消后的迟到结果。
// pending：当前动作等待状态 ref，初始 false，既驱动外观也同步拦截重复入口。
const { run, pending } = useAsyncAction()
/**
 * 同步拦截重复点击，运行当前 action，成功和非取消失败分别发事件。
 */
async function execute() {
  // DOM disabled 在下一次渲染才生效，先同步挡住同一帧的第二次点击与成功回调。
  if (pending.value) return
  try {
    // result：当前有效周期的操作结果，具体形状由被调用契约定义。
    const result = await run(props.action)
    emit('success', result)
  } catch (error) {
    // error：当前公开失败或错误 ref，主动取消不追加失败提示。

    if (error.name !== 'AbortError' && error.code !== 'CANCELLED') emit('error', error)
  }
}
</script>

<template>
  <el-button :loading="pending" :disabled="pending" @click="execute"><slot /></el-button>
</template>
