import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  errorCount: number
}

/**
 * ErrorBoundary dedicado ao Dashboard.
 * Ao capturar um erro (ex: canal Supabase Realtime ainda sendo destruído),
 * aguarda 1.5s e remonta automaticamente — máximo de 3 tentativas.
 */
export class DashboardErrorBoundary extends Component<Props, State> {
  private retryTimeout: ReturnType<typeof setTimeout> | null = null

  state: State = { hasError: false, errorCount: 0 }

  static getDerivedStateFromError(_: Error): Partial<State> {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    const { errorCount } = this.state

    if (errorCount < 3) {
      this.retryTimeout = setTimeout(() => {
        this.setState(prev => ({
          hasError: false,
          errorCount: prev.errorCount + 1,
        }))
      }, 1500)
    } else {
      console.error('[DashboardErrorBoundary] Max retries reached:', error)
    }
  }

  componentWillUnmount() {
    if (this.retryTimeout) clearTimeout(this.retryTimeout)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
          <span className="text-sm">Reconectando dashboard…</span>
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )
    }

    return this.props.children
  }
}