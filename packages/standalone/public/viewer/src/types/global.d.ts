/* eslint-disable @typescript-eslint/no-explicit-any */
export {};

declare global {
  interface SpeechRecognitionConstructor {
    new (): SpeechRecognition;
  }

  interface SpeechRecognitionAlternative {
    transcript: string;
    confidence: number;
  }

  interface SpeechRecognitionResult {
    length: number;
    isFinal: boolean;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
  }

  interface SpeechRecognitionResultList {
    length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    error: string;
  }

  interface SpeechRecognitionEvent extends Event {
    resultIndex: number;
    results: SpeechRecognitionResultList;
  }

  interface SpeechRecognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onend: (() => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    start(): void;
    stop(): void;
  }

  interface VisNodeRecord {
    id?: string | number;
    from?: string | number;
    to?: string | number;
    font?: {
      color?: string;
      [key: string]: unknown;
    };
    color?: unknown;
    label?: string;
    title?: string;
    size?: number;
    borderWidth?: number;
    data?: unknown;
    hidden?: boolean;
    opacity?: number;
    [key: string]: unknown;
  }

  interface VisDataSet<T extends VisNodeRecord> {
    get(): T[];
    update(item: Partial<T> | Partial<T>[]): void;
    add(items: T | T[]): void;
    clear?(): void;
    remove?(id: string | number | Array<string | number>): void;
  }

  interface VisNetworkDataContext {
    nodes: VisDataSet<VisNodeRecord>;
    edges: VisDataSet<VisNodeRecord>;
  }

  interface VisNetwork {
    on(
      event: 'click' | 'stabilized',
      handler: (params: { nodes: Array<string | number> }) => void
    ): void;
    body: {
      data: VisNetworkDataContext;
    };
    focus(nodeId: string | number, options?: unknown): void;
    selectNodes(ids: Array<string | number>): void;
    destroy?: () => void;
  }

  interface VisConstructor {
    DataSet: new <T extends VisNodeRecord>(items?: T[]) => VisDataSet<T>;
    DataSet<T extends VisNodeRecord>(items?: T[]): VisDataSet<T>;
    Network: new (
      container: HTMLElement,
      data: Record<string, unknown>,
      options: unknown
    ) => VisNetwork;
  }

  const vis: VisConstructor;
  const marked: {
    parse(
      markdown: string,
      options?: {
        mangle?: boolean;
        headerIds?: boolean;
        sanitize?: boolean;
      }
    ): string;
  };
  const lucide: {
    createIcons(config?: unknown): void;
  };

  interface Window {
    switchTab?: (tab: string) => void;
    chatModule?: {
      toggleToolCard: (toolId: string) => void;
    };
    graphModule?: {
      navigateToNode: (nodeId: string) => void;
    };
    memoryModule?: {
      toggleCard: (index: number) => void;
      searchWithQuery: (query: string) => Promise<void>;
      showSaveFormWithText: (text: string) => void;
      showSaveForm: () => void;
    };
    settingsModule?: {
      init?: () => Promise<void>;
      addCronJob?: () => Promise<void>;
      resetForm?: () => void;
      saveAndRestart?: () => Promise<void>;
      toggleAgent: (agentId: string, enabled: boolean) => Promise<void>;
      onAgentBackendChange: (agentId: string) => void;
      saveAgentConfig: (agentId: string) => Promise<void>;
      toggleAllGateway?: (checked: boolean) => void;
      toggleAllMCP?: (checked: boolean) => void;
      toggleCronJob?: (id: string, enabled: boolean) => Promise<void>;
      deleteCronJob?: (id: string) => Promise<void>;
    };
    skillsModule?: {
      closeDetail?: () => void;
      install?: (source: string, name: string) => Promise<void>;
      uninstall?: (source: string, name: string) => Promise<void>;
      toggle?: (source: string, name: string, enabled: boolean) => Promise<void>;
      init?: () => Promise<void>;
      loadSkills?: () => Promise<void>;
      render?: () => void;
    };
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    lucideConfig?: unknown;
  }
}
