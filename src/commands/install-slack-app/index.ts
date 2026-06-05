import type { Command } from '../../commands'

const installSlackApp = {
  type: 'local',
  name: 'install-slack-app',
  description: 'Install the Vivus Slack app',
  availability: ['vivus-ai'],
  supportsNonInteractive: false,
  load: () => import('./install-slack-app'),
} satisfies Command

export default installSlackApp
