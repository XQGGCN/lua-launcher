export type WindowTitleBarStyle = 'integrated' | 'native'
export type ZoomPercent = 90 | 100 | 110 | 125
/** Absent zoomPercent is the exact legacy schema1 shape and means100% to consumers. */
export interface WindowPreferences { titleBarStyle: WindowTitleBarStyle; rememberBounds: boolean; zoomPercent?: ZoomPercent }
export interface WindowRect { x: number; y: number; width: number; height: number }
export interface WindowState { normalBounds?: WindowRect; maximized: boolean }
export interface WindowPreferencesSnapshot { preferences: WindowPreferences; state: WindowState; issue?: string }
export interface WindowZoomStatus {
  requestedPercent: ZoomPercent
  effectivePercent: ZoomPercent | null
  supportedPercents: ZoomPercent[]
  busy: boolean
  issue?: string
  reason?: string
}
/** Effective chrome/platform capabilities belong to the main-process window controller. */
export interface WindowPreferencesStatus {
  preferences: WindowPreferences
  effectiveTitleBarStyle: WindowTitleBarStyle
  pendingTitleBarChange: boolean
  supportsTitleBarStyle: boolean
  positionManagedByDesktop: boolean
  zoom?: WindowZoomStatus
  issue?: string
}
