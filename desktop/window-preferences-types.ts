export type WindowTitleBarStyle = 'integrated' | 'native'
export interface WindowPreferences { titleBarStyle: WindowTitleBarStyle; rememberBounds: boolean }
export interface WindowRect { x: number; y: number; width: number; height: number }
export interface WindowState { normalBounds?: WindowRect; maximized: boolean }
export interface WindowPreferencesSnapshot { preferences: WindowPreferences; state: WindowState; issue?: string }
/** Effective chrome/platform capabilities belong to the main-process window controller. */
export interface WindowPreferencesStatus {
  preferences: WindowPreferences
  effectiveTitleBarStyle: WindowTitleBarStyle
  pendingTitleBarChange: boolean
  supportsTitleBarStyle: boolean
  positionManagedByDesktop: boolean
  issue?: string
}
