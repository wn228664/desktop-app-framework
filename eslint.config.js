import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

/**
 * JS/Vue 的语义检查由 ESLint 承担，排版交给 Prettier，避免两套工具互相改写模板。
 * 关闭项仅为 Vue 命名/排版选择，不关闭未定义变量、未使用变量或 props/emits 等语义规则。
 * 产物和报告排除在源代码检查外；构建常量 __DESKTOP_CONFIG__ 仅声明为只读。
 */
export default [
  { ignores: ['out/**', 'release/**', 'artifacts/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.{js,cjs,vue}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, __DESKTOP_CONFIG__: 'readonly' },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
    },
  },
]
