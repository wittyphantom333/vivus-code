// Quick test for compressConversation
import { readFileSync } from 'fs'

// Extract the function from server.mjs (it's not exported, so we eval it)
const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')

// Find and extract the compressConversation function
const fnMatch = src.match(/function compressConversation\([\s\S]*?^}/m)
if (!fnMatch) { console.log('❌ Could not find compressConversation'); process.exit(1) }

// Also need extractOriginalQuery 
const eqMatch = src.match(/function extractOriginalQuery\([\s\S]*?^}/m)

// Eval in a scope
const fn = new Function('return ' + fnMatch[0])()

// Simulate a typical /init conversation with 10 tool results
const messages = [
  { role: 'system', content: 'You are a coding agent. CWD: /home/user/project\n\nFILE CREATION RULES...' },
  { role: 'user', content: '/init' },
  // Round 1: Bash ls
  { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: { command: 'ls -la' } } }] },
  { role: 'tool', tool_call_id: 'tc1', content: 'total 48\ndrwxr-xr-x  8 user user 4096 Jan 1 00:00 .\n-rw-r--r--  1 user user 1234 Jan 1 00:00 package.json\n-rw-r--r--  1 user user  567 Jan 1 00:00 tsconfig.json\ndrwxr-xr-x  3 user user 4096 Jan 1 00:00 src/' },
]

// Add 9 more Read tool calls with substantial content
for (let i = 2; i <= 10; i++) {
  const fname = `src/file${i}.ts`
  messages.push({
    role: 'assistant', content: '',
    tool_calls: [{ id: `tc${i}`, type: 'function', function: { name: 'Read', arguments: { file_path: fname } } }]
  })
  messages.push({
    role: 'tool', tool_call_id: `tc${i}`,
    content: `export function handler${i}() {\n  // Long implementation\n  ${'const x = doSomething();\n  '.repeat(50)}\n}`
  })
}

// Test compression
const result = fn(messages, '/init')
console.log('Compressed messages:', result.length)
console.log('System length:', result[0].content.length, 'chars')
console.log('User length:', result[1].content.length, 'chars')
const totalChars = result.reduce((s, m) => s + m.content.length, 0)
console.log('Total:', totalChars, 'chars ≈', Math.ceil(totalChars * 0.3), 'tokens')

// Verify structure
console.log('\nSystem role:', result[0].role)
console.log('User role:', result[1].role)
console.log('\nUser content preview:', result[1].content.slice(0, 200))
console.log('\n✅ Compression test passed')
