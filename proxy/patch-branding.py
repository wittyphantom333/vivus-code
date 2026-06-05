#!/usr/bin/env python3
"""Patch Claude Code cli.js to replace visible branding with Vivus.
Re-run after npm updates: python3 ts/proxy/patch-branding.py"""

p = '/Users/witt/.nvm/versions/node/v20.12.2/lib/node_modules/@anthropic-ai/claude-code/cli.js'
t = open(p).read()

replacements = [
    # App constructor title (the box border title source)
    ('title:"Claude Code"', 'title:"Vivus"'),
    # React component title bar: "Vivus v2.1.92"
    ('title:`Claude Code v', 'title:`Vivus v'),
    # Styled title in status line
    ('("Claude Code")} ${b7("inactive",o)(`v${b}`)} `,_6=b7("claude",o)(" Claude Code "',
     '("Vivus")} ${b7("inactive",o)(`v${b}`)} `,_6=b7("claude",o)(" Vivus "'),
    # UI constant
    ('AKK="Claude Code"', 'AKK="Vivus"'),
    # Bold heading
    ('createElement(T,{bold:!0},"Claude Code")', 'createElement(T,{bold:!0},"Vivus")'),
    # Default agent name fallback
    ('L_??"Claude Code"', 'L_??"Vivus"'),
    # Onboarding text
    ('createElement(T,null,"Claude Code"', 'createElement(T,null,"Vivus"'),
    # Desktop promo
    ('title:"Try Claude Code Desktop"', 'title:"Try Vivus Desktop"'),
    # MCP transport label
    ('?"claude.ai":"Claude Code"', '?"claude.ai":"Vivus"'),
    # Windows path
    ('Tt(_,"Claude Code","ChromeNativeHost")', 'Tt(_,"Vivus","ChromeNativeHost")'),
    # Welcome tips
    ('instructions for Claude', 'instructions for Vivus'),
    ('Ask Claude to create', 'Ask Vivus to create'),
    # Welcome tip filename (visible in UI only)
    ('create a CLAUDE.md file', 'create a VIVUS.md file'),
]

total = 0
for old, new in replacements:
    c = t.count(old)
    t = t.replace(old, new)
    total += c
    status = 'OK' if c > 0 else 'SKIP'
    print(f'  {c}x: {old[:60]}... {status}')

# NOTE: Do NOT bulk-replace CLAUDE.md -> VIVUS.md. It breaks the React UI
# because some occurrences are part of structural code, not just strings.

open(p, 'w').write(t)
print(f'\nPatched {total} occurrences total.')
