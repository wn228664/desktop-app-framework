import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 业务无关的导航与路由共用一份定义，label 同时用于侧栏、页面面包屑与可访问名称。
 * Hash history 兼容 file:// 安装包，不需要服务端回退规则；页面懒加载，不缓存页面草稿。
 * 扩展页面时在此添加定义，真实权限和服务端菜单应在接入项目按契约设计，不在框架里预设。
 */
export const navigation = [
  {
    path: '/',
    name: 'overview',
    label: '框架概览',
    icon: 'grid',
    component: () => import('./views/Overview.vue'),
  },
  {
    path: '/components',
    name: 'components',
    label: '通用组件',
    icon: 'layers',
    component: () => import('./views/Components.vue'),
  },
  {
    path: '/table',
    name: 'table',
    label: '表格与搜索',
    icon: 'table',
    component: () => import('./views/Table.vue'),
  },
  {
    path: '/desktop',
    name: 'desktop',
    label: '桌面能力',
    icon: 'window',
    component: () => import('./views/Desktop.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    label: '应用设置',
    icon: 'settings',
    component: () => import('./views/Settings.vue'),
  },
]

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    ...navigation.map(({ label, ...item }) => ({ ...item, meta: { title: label } })),
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
