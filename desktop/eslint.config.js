// @ts-check
import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'out-e2e/**',
      'dist/**',
      'build/**',
      'test-results/**',
      'screenshots/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // essential 只包含"可能是 bug"的规则（重复 key、computed 副作用等），不含格式类规则——
  // 仓库没有 Prettier，strongly-recommended/recommended 的属性换行等格式规则会在既有代码上
  // 炸出上千条噪音警告，掩盖真正有意义的告警。
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    files: ['src/pet/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'vue/multi-word-component-names': 'off',
    },
  },
)
