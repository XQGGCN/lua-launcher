import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeCrash } from './crash-analysis'

test('common crash causes are recognised in plain language', () => {
  assert.equal(analyzeCrash(['Exception in thread "main" java.lang.OutOfMemoryError: Java heap space']).title, '游戏内存不足')
  assert.equal(analyzeCrash(['java.lang.UnsupportedClassVersionError: x has been compiled by a more recent version of the Java Runtime']).title, 'Java 版本不匹配')
  assert.equal(analyzeCrash(['Incompatible mods found!', ' - Mod sodium requires fabric-api']).title, '模组缺少前置或互不兼容')
  assert.equal(analyzeCrash(['GLFW error 65542: WGL: The driver does not appear to support OpenGL']).title, '显卡驱动不支持或未正确安装')
  assert.equal(analyzeCrash(['org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError']).title, '模组之间发生冲突（Mixin）')
})

test('crash report descriptions are used when no rule matches', () => {
  const result = analyzeCrash(['nothing useful'], { name: 'crash-2026-10-22_10.00.00-client.txt', text: '---- Minecraft Crash Report ----\nDescription: Ticking entity\n\njava.lang.NullPointerException' })
  assert.equal(result.title, '游戏崩溃：Ticking entity')
  assert.equal(result.report, 'crash-2026-10-22_10.00.00-client.txt')
  assert.ok(result.hints.length >= 1)
  assert.equal(analyzeCrash([]).title, '游戏意外退出')
})
