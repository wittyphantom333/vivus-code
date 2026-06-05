import type { FileStateCache } from '../../utils/fileStateCache'
import type { ThemeName } from '../../utils/theme'

export type TipContext = {
  theme: ThemeName
  bashTools?: Set<string>
  readFileState?: FileStateCache
}

export type Tip = {
  id: string
  content: (ctx: TipContext) => Promise<string>
  cooldownSessions: number
  isRelevant?: (context?: TipContext) => Promise<boolean>
}
