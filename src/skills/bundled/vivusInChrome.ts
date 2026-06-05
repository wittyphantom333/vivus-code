import { BROWSER_TOOLS } from '@ant/vivus-for-chrome-mcp'
import { BASE_CHROME_PROMPT } from '../../utils/vivusInChrome/prompt'
import { shouldAutoEnableVivusInChrome } from '../../utils/vivusInChrome/setup'
import { registerBundledSkill } from '../bundledSkills'

const VIVUS_IN_CHROME_MCP_TOOLS = BROWSER_TOOLS.map(
  tool => `mcp__vivus-in-chrome__${tool.name}`,
)

const SKILL_ACTIVATION_MESSAGE = `
Now that this skill is invoked, you have access to Chrome browser automation tools. You can now use the mcp__vivus-in-chrome__* tools to interact with web pages.

IMPORTANT: Start by calling mcp__vivus-in-chrome__tabs_context_mcp to get information about the user's current browser tabs.
`

export function registerVivusInChromeSkill(): void {
  registerBundledSkill({
    name: 'vivus-in-chrome',
    description:
      'Automates your Chrome browser to interact with web pages - clicking elements, filling forms, capturing screenshots, reading console logs, and navigating sites. Opens pages in new tabs within your existing Chrome session. Requires site-level permissions before executing (configured in the extension).',
    whenToUse:
      'When the user wants to interact with web pages, automate browser tasks, capture screenshots, read console logs, or perform any browser-based actions. Always invoke BEFORE attempting to use any mcp__vivus-in-chrome__* tools.',
    allowedTools: VIVUS_IN_CHROME_MCP_TOOLS,
    userInvocable: true,
    isEnabled: () => shouldAutoEnableVivusInChrome(),
    async getPromptForCommand(args) {
      let prompt = `${BASE_CHROME_PROMPT}\n${SKILL_ACTIVATION_MESSAGE}`
      if (args) {
        prompt += `\n## Task\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
