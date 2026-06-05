import type { Command } from '../../commands'
import { isVivusAISubscriber } from '../../utils/auth'

const rateLimitOptions = {
  type: 'local-jsx',
  name: 'rate-limit-options',
  description: 'Show options when rate limit is reached',
  isEnabled: () => {
    if (!isVivusAISubscriber()) {
      return false
    }

    return true
  },
  isHidden: true, // Hidden from help - only used internally
  load: () => import('./rate-limit-options'),
} satisfies Command

export default rateLimitOptions
