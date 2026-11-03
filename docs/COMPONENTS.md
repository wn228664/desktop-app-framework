# 组件与交互契约

基础控件直接使用 Element Plus；封装只处理反复出现的布局、异步和数据契约，不重新实现按钮、选择器、日期控件等成熟组件。

## 组件清单

| 组件          | 主要输入                                            | 输出 / 约束                                              |
| ------------- | --------------------------------------------------- | -------------------------------------------------------- |
| FrameworkPage | title、description、scroll=true                     | actions 默认插槽；scroll=false 时父级需给子组件确定高度  |
| StateView     | loading、error、empty、emptyText                    | retry；加载优先于错误，错误优先于空态                    |
| AsyncButton   | action(signal)                                      | success(result)、error(error)；同步互斥、卸载取消        |
| SchemaForm    | modelValue、fields、disabled                        | update:modelValue；暴露 validate / clearValidate         |
| SearchForm    | modelValue、fields、loading                         | search(snapshot)、reset、update:modelValue               |
| DataTable     | columns、items 或 loader、query、rowKey、selectable | loaded、selection-change；暴露 reload / clearSelection   |
| ActionDialog  | v-model、title、submit(signal)、mode、confirmText   | success；mode 为 dialog 或 drawer                        |
| FileUpload    | path、field=file                                    | uploaded({file,result})、error；授权读取、顺序上传与取消 |
| AppIcon       | name、size=20                                       | 纯展示 SVG，不加载远端图标字体                           |

## 表格与搜索

```vue
<SearchForm :fields="searchFields" @search="query = $event" />
<DataTable
  :columns="columns"
  :loader="loadRows"
  :query="query"
  row-key="id"
  selectable
  @selection-change="selected = $event"
/>
```

远程 loader 接收 `{page, pageSize, query, sort, signal}`，page 从 1 开始；返回 `{rows: Array, total: 非负整数}`。每行必须有非空的唯一键。`sort` 为 `{prop, order}`，order 为 `ascending`、`descending` 或空；服务端字段映射由接入层处理，不可直接拼 SQL。

本地模式传 items，远程模式传 loader；同时传入时 loader 优先。条件变化回第一页并使旧请求失效。删除导致页码超出总数时回到有效页。分页/筛选变化清除选择，避免对不可见旧行执行操作。

本地排序按值类型处理：数值保留负数和小数的正确顺序，Date 按时间排序，字符串按中文自然顺序排序。数字字符串仍按自然文本处理，不猜测格式化后的金额、百分比或其他业务展示语义。

columns 与 Element Plus `el-table-column` 常用属性兼容：`prop`、`label`、`width`、`minWidth`、`fixed`、`sortable`。框架 formatter 签名为 `(value, row)`。每列可用同名插槽接收 `{row,value}`；toolbar 插槽用于通用操作。

列显隐只在当前组件生命周期保留，不把不同页面列配置混存。复杂树表、单元格编辑、虚拟滚动可直接使用 Element Plus 原始表格或新增专项组件，不强塞进此组件。

搜索字段支持 text 与 select：`key`、`label`、`placeholder`、`maxlength`、`options:[{label,value}]`。提交快照会清理空字符串/null/undefined，保留 `0` 与 `false`。重置发出一次 search({})。

## 表单

fields 支持 `key`、`label`、`type`、`rules`、`maxlength`、`placeholder`、`help`、`options`。type 为 text、textarea、select、switch。rules 使用 Element Plus 表单校验契约。

具名插槽与字段 key 同名，接收 `{value,update}`，适用于日期、联动、多选等扩展。需要复杂跨字段规则时在调用方处理，组件不会推断业务关联。

调用 `await formRef.validate()`；校验失败会拒绝 Promise，调用方需决定提示。组件不擅自提交网络、不修改 props，不在失败时清空用户输入。

## 弹窗 / 抽屉

```vue
<ActionDialog v-model="open" title="编辑内容" :submit="save" @success="reload">
  <SchemaForm ref="form" v-model="draft" :fields="fields" />
</ActionDialog>
```

`save(signal)` 需完成校验和保存；失败保持打开并展示 error.message。保存期间禁止遮罩和 Escape 意外关闭；取消按钮仍允许主动取消。关闭撤销当前动作，下一次打开不会收到旧成功结果。内容只在弹窗/抽屉内部滚动，头部和底部操作保持可达。

Element Plus 负责焦点管理与键盘行为；不要在 slot 里重复添加全局 document keydown 或嵌套另一个弹窗。

## 文件上传

```vue
<FileUpload path="uploads" field="file" @uploaded="handleUploaded" @error="handleError" />
```

`path` 是可信 API 基址下的相对路径；需先配置 API。留空时可选择文件，上传按钮禁用并说明原因。文件大小上限 20 MiB；一次原生选择最多 10 个，主进程授权总量最多 100 个。

上传顺序执行，成功后释放对应授权，失败保留未完成文件。FormData 字段名由 field 指定；请求沿用主进程凭据和超时，不手工设置 multipart boundary。

成功文件会先移出可上传队列，再释放授权；即使 IPC 清理失败，也不会因此再次提交已经成功的文件。授权清理失败通过 error 事件告知，窗口销毁仍会统一撤销授权。

Fetch 没有可靠的上传字节进度，任务使用“发送中”状态，完成后才显示完整字节数，不编造百分比。下载使用响应流的实际读取进度；未知总长时展示不定进度。

## 基础函数

- `useAsyncAction()`：pending、error、run(operation)、cancel()；组件卸载自动 cancel。
- `createAsyncAction(onChange)`：无 Vue 依赖的动作控制器；销毁后拒绝新任务。
- `delay(milliseconds, signal)`：可取消等待，单位毫秒。
- `useDebouncedRef(initial='', milliseconds=300)`：防抖响应式值；卸载清理计时器。
- `formatBytes(bytes)`：非负字节数转 B/KiB/MiB/GiB/TiB；非法值显示 `—`。
- `formatDate(value, options)`：使用本地时区；空值/无效日期显示 `—`。
- `compactQuery(object)`：浅层去空值，不修改原对象。
- `isHttpsUrl(value)`：展示层的 URL 检查，不能代替主进程安全校验。
- `compareValues(left,right)`：供本地表格排序使用，保留数值/日期类型；升序时空值置后。

测试覆盖交互与边界，不按导出函数数量堆同义测试。新增封装前先确认是否可直接使用 Element Plus 或已有基础方法。
