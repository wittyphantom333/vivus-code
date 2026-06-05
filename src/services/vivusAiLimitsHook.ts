import { useEffect, useState } from 'react'
import {
  type VivusAILimits,
  currentLimits,
  statusListeners,
} from './vivusAiLimits'

export function useVivusAiLimits(): VivusAILimits {
  const [limits, setLimits] = useState<VivusAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: VivusAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
