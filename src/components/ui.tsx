import { useEffect, useRef, type ReactNode } from 'react'
import { AlertCircle, LoaderCircle, RefreshCw, X } from 'lucide-react'

export function Spinner({ size = 17 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />
}
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-box" role="alert"><AlertCircle size={18} /><span>{message}</span>{retry && <button className="text-button" onClick={retry}>重试 <RefreshCw size={14} /></button>}</div>
}
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p>{action}</div>
}
export function PageHeading({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>
}
export function Dialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div className="modal-inner"><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="关闭对话框"><X size={20} /></button></div>{children}</div>
  </dialog>
}
export const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`
export const percent = (progress?: { completed: number; total: number }) => progress && progress.total > 0 ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 0
