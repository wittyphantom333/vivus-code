import type { Command } from '../../commands'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: 'Show QR code to download the Vivus mobile app',
  load: () => import('./mobile'),
} satisfies Command

export default mobile
