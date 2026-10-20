// Keys from Modrinth's mod category tags; BBSMC publishes the equivalent Chinese names.
export const modCategories = [
  { key: 'optimization', label: '性能优化', bbsmc: '优化' },
  { key: 'worldgen', label: '世界生成', bbsmc: '世界生成' },
  { key: 'adventure', label: '冒险探索', bbsmc: '冒险' },
  { key: 'technology', label: '科技', bbsmc: '科技' },
  { key: 'magic', label: '魔法', bbsmc: '魔法' },
  { key: 'decoration', label: '建筑装饰', bbsmc: '装饰' },
  { key: 'utility', label: '实用工具', bbsmc: '实用工具' },
  { key: 'storage', label: '仓储收纳', bbsmc: '存储' },
  { key: 'library', label: '前置库', bbsmc: '前置' },
  { key: 'game-mechanics', label: '游戏机制', bbsmc: '游戏机制' },
  { key: 'mobs', label: '生物', bbsmc: '生物' },
  { key: 'equipment', label: '装备', bbsmc: '装备' },
  { key: 'food', label: '食物', bbsmc: '食物' },
  { key: 'transportation', label: '交通', bbsmc: '交通' },
  { key: 'economy', label: '经济', bbsmc: '经济' },
  { key: 'social', label: '社交', bbsmc: '社交' },
  { key: 'management', label: '管理', bbsmc: '管理' },
  { key: 'minigame', label: '小游戏', bbsmc: '小游戏' },
  { key: 'cursed', label: '趣味整活', bbsmc: '诅咒' },
] as const

export type ModCategory = typeof modCategories[number]['key']

export function categoryLabel(value: string) {
  return modCategories.find(category => category.key === value || category.bbsmc === value)?.label || value
}

export function categoryFacet(category: string, source: 'modrinth' | 'bbsmc' = 'modrinth') {
  const entry = modCategories.find(item => item.key === category)
  if (!entry) throw new Error('不支持的模组分类')
  return source === 'bbsmc' ? entry.bbsmc : entry.key
}
