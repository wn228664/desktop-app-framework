import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 业务无关的导航与路由共用一份定义，label 同时用于侧栏、页面面包屑与可访问名称。
 * Hash history 兼容 file:// 安装包，不需要服务端回退规则；页面懒加载，不缓存页面草稿。
 * 扩展页面时在此添加定义，真实权限和服务端菜单应在接入项目按契约设计，不在框架里预设。
 */
// navigation：中性页面路由与导航元数据的唯一清单，hash history 适配打包 HTML。
export const navigation = [
  {
    path: '/',
    name: 'overview',
    label: '框架概览',
    icon: 'grid',
    /**
     * 按导航需要懒加载概览页。
     */
    component: () => import('./views/Overview.vue'),
  },
  {
    path: '/components',
    name: 'components',
    label: '通用组件',
    icon: 'layers',
    /**
     * 按导航需要懒加载通用组件页。
     */
    component: () => import('./views/Components.vue'),
  },
  {
    path: '/table',
    name: 'table',
    label: '表格与搜索',
    icon: 'table',
    /**
     * 按导航需要懒加载表格页。
     */
    component: () => import('./views/Table.vue'),
  },
  {
    path: '/desktop',
    name: 'desktop',
    label: '桌面能力',
    icon: 'window',
    /**
     * 按导航需要懒加载桌面能力页。
     */
    component: () => import('./views/Desktop.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    label: '应用设置',
    icon: 'settings',
    /**
     * 按导航需要懒加载设置页。
     */
    component: () => import('./views/Settings.vue'),
  },
]

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    ...navigation.map(
      /**
       * 将导航标题转换为路由 meta，保留原路由配置。
       * label：路由展示标题，转换为 meta.title 供标题和面包屑消费。
       * item：去掉 label 后的路由配置，包含 path/name/icon/component。
       */
      ({ label, ...item }) => ({ ...item, meta: { title: label } }),
    ),
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
