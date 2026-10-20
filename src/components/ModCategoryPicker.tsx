import { modCategories, type ModCategory } from '../mod-categories'

export default function ModCategoryPicker({ value, change }: {
  value: ModCategory | ''
  change: (value: ModCategory | '') => void
}) {
  return <section className="mod-category-picker" aria-labelledby="mod-category-title">
    <div className="mod-category-heading"><h2 id="mod-category-title">按功能选择</h2><span>单选分类，可继续筛选加载器和游戏版本</span></div>
    <div className="mod-category-options" role="group" aria-label="模组功能分类">
      <button type="button" className={!value ? 'selected' : ''} aria-pressed={!value} onClick={() => change('')}>全部模组</button>
      {modCategories.map(category => <button type="button" key={category.key} className={value === category.key ? 'selected' : ''} aria-pressed={value === category.key} onClick={() => change(category.key)}>{category.label}</button>)}
    </div>
  </section>
}
