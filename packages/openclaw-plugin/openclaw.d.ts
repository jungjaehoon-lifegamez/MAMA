declare module 'openclaw/plugin-sdk' {
  export interface OpenClawPluginApi {
    on(event: string, handler: (event: unknown) => unknown | Promise<unknown>): void;
    registerTool(tool: Record<string, unknown>): void;
  }
}
