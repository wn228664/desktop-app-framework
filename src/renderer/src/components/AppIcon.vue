<script setup>
/**
 * 本地 SVG 图标，不加载远程字体或外部资源。name 未识别时回退 grid，size 默认 20 个逻辑像素。
 * SVG 标为 aria-hidden，图标按钮/折叠导航必须在外层提供 aria-label 或可见文本。
 * 新图标在 paths 中定义 24×24 viewBox 路径；颜色跟随 currentColor，避免明暗主题各维护一份素材。
 */
defineProps({ name: { type: String, default: 'grid' }, size: { type: Number, default: 20 } })
const paths = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  layers: 'm12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',
  table: 'M3 4h18v16H3z M3 9h18 M9 9v11 M3 14h18',
  window: 'M3 4h18v16H3z M3 9h18 M6 6.5h1 M9 6.5h1 M9 13l-3 3 3 2 M14 13l3 3-3 2',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  check: 'm5 12 4 4L19 6',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h5',
  shield: 'm12 3 9 4v5c0 5-9 10-9 10S3 17 3 12V7z m-4 9 3 3 5-6',
}
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.grid" />
  </svg>
</template>
