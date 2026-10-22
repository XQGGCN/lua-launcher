import assert from 'node:assert/strict'
import test from 'node:test'
import { plainNotes } from './release-notes'

test('release notes drop Markdown syntax for the update dialog', () => {
  const notes = '# Lua 0.10.2\n\n## 修复\n\n- **内存**：按 `vm_stat` 计算，见[说明](https://example.com)。\n  - 子项\n\n\n\n结尾'
  assert.equal(plainNotes(notes), 'Lua 0.10.2\n\n修复\n\n· 内存：按 vm_stat 计算，见说明。\n  · 子项\n\n结尾')
})
