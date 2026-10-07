import { Component } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { DataProblemScreen } from './DataProblemScreen'
import type { ReactNode } from 'react'
import { isDecryptError } from '@/lib/dataErrors'
import {
  clearDataProblem,
  reportDataProblem,
  useDataProblem,
} from '@/lib/dataProblem'
import { quarantineKey } from '@/lib/localDb'

const NO_ERROR = Symbol('no-error')

// Catches a DecryptError thrown during render, reports it, and renders
// nothing (the gate then swaps in the Data problem screen). Any other error
// is rethrown so it propagates exactly as before.
export class DataErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: NO_ERROR }

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }

  componentDidCatch(error: unknown): void {
    if (isDecryptError(error)) reportDataProblem(error)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error !== NO_ERROR) {
      if (isDecryptError(error)) return null
      throw error
    }
    return this.props.children
  }
}

export function DataProblemGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const problem = useDataProblem()

  if (problem) {
    const handleRetry = async () => {
      await queryClient.resetQueries()
      clearDataProblem()
    }
    const handleQuarantine = async () => {
      await quarantineKey(problem.storageKey)
      await queryClient.resetQueries()
      clearDataProblem()
    }
    return (
      <DataProblemScreen
        storageKey={problem.storageKey}
        onRetry={handleRetry}
        onQuarantine={handleQuarantine}
      />
    )
  }

  return <DataErrorBoundary>{children}</DataErrorBoundary>
}
