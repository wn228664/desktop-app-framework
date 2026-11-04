<script setup>
/**
 * 展示状态优先级为 loading → error → empty → 默认内容，调用方应提供同一数据源的状态。
 * Props：loading/empty 为布尔值，error 推荐传带可公开 message 的对象；emptyText 默认“暂无内容”。
 * Events：retry 只通知父级重新加载，不自行重复网络请求；默认插槽显示成功内容。
 * error 的脱敏由请求/错误边界完成，不能把原始服务端 HTML、堆栈或令牌直接传入展示。
 * 用法：<StateView :loading="pending" :error="error" :empty="!rows.length" @retry="reload">...</StateView>
 */
defineProps({
  /** 属性 loading：最高优先级加载态，默认 false。 */
  loading: Boolean,
  /** 属性 error：已经脱敏的 Error/对象/文本，默认 null，优先级低于 loading。 */
  error: { type: [Error, Object, String], default: null },
  /** 属性 empty：无数据开关，默认 false，不能替代失败。 */
  empty: Boolean,
  /** 属性 emptyText：空态说明，默认“暂无内容”。 */
  emptyText: { type: String, default: '暂无内容' },
})
defineEmits(['retry'])
</script>

<template>
  <div v-if="loading" class="state-view" role="status" aria-live="polite">
    <el-skeleton :rows="4" animated /><span>正在加载…</span>
  </div>
  <div v-else-if="error" class="state-view" role="alert">
    <el-result icon="warning" title="暂时无法加载" :sub-title="error.message || String(error)"
      ><template #extra><el-button @click="$emit('retry')">重试</el-button></template></el-result
    >
  </div>
  <el-empty v-else-if="empty" :description="emptyText" />
  <slot v-else />
</template>
