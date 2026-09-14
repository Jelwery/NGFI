export interface TraeAuthHeader {
  name: string
  value: string
}

export declare const name: 'llm-trae'
export declare const inject: readonly ['llm']
export declare function readTraeAuthHeader(path: string, now?: Date): Promise<TraeAuthHeader>
export declare function apply(context: unknown, config: unknown): void
