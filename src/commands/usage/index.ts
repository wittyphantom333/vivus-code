import type { Command } from '../../commands'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show plan usage limits',
  availability: ['vivus-ai'],
  load: () => import('./usage'),
} satisfies Command
