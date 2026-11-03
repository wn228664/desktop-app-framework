<script setup>
/**
 * 桌面内容页骨架，保留固定标题和操作区，仅让指定内容容器滚动。
 * Props：title 必填，description 可省略；scroll 默认 true，适合卡片/设置等内容页。
 * 表格页应 scroll=false，将确定高度交给 DataTable，避免外层和表格同时出现纵向滚动条。
 * Slots：默认插槽为内容，actions 为标题右侧操作；组件不持有请求或页面数据。
 * 用法：<FrameworkPage title="表格与搜索" :scroll="false"><DataTable ... /></FrameworkPage>
 */
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  scroll: { type: Boolean, default: true },
})
</script>

<template>
  <section class="framework-page">
    <header class="page-heading">
      <div>
        <h1>{{ title }}</h1>
        <p v-if="description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="page-actions"><slot name="actions" /></div>
    </header>
    <div class="page-content" :class="{ 'content-scroll': scroll }"><slot /></div>
  </section>
</template>
