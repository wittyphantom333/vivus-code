import type { Command } from '../../commands'
import { isPolicyAllowed } from '../../services/policyLimits/index'
import { isVivusAISubscriber } from '../../utils/auth'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  isEnabled: () =>
    isVivusAISubscriber() && isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isVivusAISubscriber() || !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-env'),
} satisfies Command
