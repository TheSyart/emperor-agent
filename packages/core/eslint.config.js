// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 迁移期沿用了 Python 磁盘格式的 snake_case 键名，unused-vars 用 _ 前缀放行占位参数。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
)
