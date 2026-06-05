export type ConnectorTextBlock = { type: 'connector_text'; text: string }
export function isConnectorTextBlock(block: any): block is ConnectorTextBlock {
  return block?.type === 'connector_text'
}
