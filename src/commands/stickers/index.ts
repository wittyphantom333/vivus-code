import type { Command } from '../../commands'

const stickers = {
  type: 'local',
  name: 'stickers',
  description: 'Order Vivus stickers',
  supportsNonInteractive: false,
  load: () => import('./stickers'),
} satisfies Command

export default stickers
