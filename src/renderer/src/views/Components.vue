<script setup>
/**
 * 通用组件的本地交互示例，展示契约而不伪造业务后端。
 * 表单草稿由本页持有；按钮/浮层控制异步生命周期；delay 仅模拟耗时，成功提示明确标注本地提交。
 * 上传示例保留空路径，因此能验证文件选择，但不会向未知服务发送文件。
 */
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import FrameworkPage from '../components/FrameworkPage.vue'
import AsyncButton from '../components/AsyncButton.vue'
import ActionDialog from '../components/ActionDialog.vue'
import SchemaForm from '../components/SchemaForm.vue'
import FileUpload from '../components/FileUpload.vue'
import StateView from '../components/StateView.vue'
import { delay } from '../core/async-action.js'

const dialog = ref(false)
const drawer = ref(false)
const form = ref()
const model = ref({ name: '', note: '', enabled: true })
const state = ref('content')
const fields = [
  {
    key: 'name',
    label: '示例名称',
    maxlength: 40,
    placeholder: '输入一个通用示例名称',
    rules: [{ required: true, whitespace: true, message: '请填写名称', trigger: 'blur' }],
  },
  {
    key: 'note',
    label: '备注',
    type: 'textarea',
    maxlength: 300,
    help: '仅用于本地组件演示，不发送网络请求。',
  },
  { key: 'enabled', label: '启用选项', type: 'switch' },
]
const showError = (error) => ElMessage.error(error.message)
/**
 * @param {AbortSignal} signal 来自 AsyncButton，用于演示可取消提交。
 * @returns {Promise<Object>} 通过表单校验后的草稿浅拷贝；不写磁盘、不发网络请求。
 * 校验拒绝统一变成可展示错误，草稿保留原值供用户修正；真实项目应在这里接入服务适配。
 */
async function submit(signal) {
  try {
    await form.value.validate()
  } catch {
    throw new Error('请先完成表单校验')
  }
  await delay(700, signal)
  return { ...model.value }
}
function success() {
  ElMessage.success('本地示例提交完成')
}
</script>

<template>
  <FrameworkPage title="通用组件" description="保留成熟组件的能力，只封装重复的交互契约。">
    <div class="two-column">
      <section class="panel">
        <div class="panel-heading">
          <h2>表单与异步提交</h2>
          <span class="subtle-badge">SchemaForm</span>
        </div>
        <p class="panel-description">字段配置、校验与插槽扩展。示例数据仅保留在当前界面。</p>
        <SchemaForm ref="form" v-model="model" :fields="fields" /><AsyncButton
          type="primary"
          :action="submit"
          @success="success"
          @error="showError"
          >校验并本地提交</AsyncButton
        >
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>弹窗与抽屉</h2>
          <span class="subtle-badge">ActionDialog</span>
        </div>
        <p class="panel-description">
          内置异步互斥、取消、错误保留与内容滚动。支持键盘和焦点管理。
        </p>
        <div class="dialog-preview">
          <div><span /><span /><span /></div>
          <i /><i /><i />
          <footer><span /><strong /></footer>
        </div>
        <div class="button-row">
          <el-button type="primary" plain @click="dialog = true">打开弹窗</el-button
          ><el-button @click="drawer = true">打开抽屉</el-button>
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>文件选择与上传</h2>
          <span class="subtle-badge">FileUpload</span>
        </div>
        <p class="panel-description">从原生选择器获取文件授权。配置上传路径后即可接入真实传输。</p>
        <FileUpload @error="showError" />
      </section>
      <section class="panel">
        <div class="panel-heading">
          <h2>加载、空态与错误</h2>
          <span class="subtle-badge">StateView</span>
        </div>
        <el-segmented
          v-model="state"
          :options="[
            { label: '内容', value: 'content' },
            { label: '加载', value: 'loading' },
            { label: '空态', value: 'empty' },
            { label: '错误', value: 'error' },
          ]"
        />
        <div class="state-preview">
          <StateView
            :loading="state === 'loading'"
            :empty="state === 'empty'"
            :error="state === 'error' ? { message: '这里是可重试错误的本地示例' } : null"
            @retry="state = 'content'"
            ><div class="ready-state">
              <span>✓</span><strong>内容准备就绪</strong>
              <p>统一展示状态，让每次交互都有回应。</p>
            </div></StateView
          >
        </div>
      </section>
    </div>
    <ActionDialog
      v-model="dialog"
      title="通用弹窗"
      :submit="
        async (signal) => {
          await delay(700, signal)
          return true
        }
      "
      @success="success"
      ><p>这是一个本地交互示例。点击保存会执行可取消的演示任务。</p>
      <el-alert
        title="任务运行时可点击「取消操作」，迟到结果不会影响下一次打开。"
        type="info"
        :closable="false"
    /></ActionDialog>
    <ActionDialog
      v-model="drawer"
      title="通用抽屉"
      mode="drawer"
      :submit="
        async (signal) => {
          await delay(700, signal)
          return true
        }
      "
      @success="success"
      ><p>同一份异步操作契约，适用于侧边抽屉。</p>
      <div v-for="index in 12" :key="index" class="drawer-example">
        通用内容区域 {{ String(index).padStart(2, '0') }}
      </div></ActionDialog
    >
  </FrameworkPage>
</template>
