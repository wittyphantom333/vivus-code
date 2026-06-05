import { formatTotalCost } from '../../cost-tracker'
import { currentLimits } from '../../services/vivusAiLimits'
import type { LocalCommandCall } from '../../types/command'
import { isVivusAISubscriber } from '../../utils/auth'

export const call: LocalCommandCall = async () => {
  if (isVivusAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Vivus usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Vivus usage'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value }
  }
  return { type: 'text', value: formatTotalCost() }
}
