declare module "sortablejs" {
  export interface SortableEvent {
    oldIndex?: number;
    newIndex?: number;
  }

  export interface SortableOptions {
    animation?: number;
    onEnd?: (event: SortableEvent) => void;
  }

  export default class Sortable {
    static create(element: HTMLElement, options?: SortableOptions): Sortable;
    destroy(): void;
  }
}

declare module "@yaireo/tagify" {
  export interface TagifyTagData {
    value: string;
  }

  export interface TagifySettings {
    whitelist?: string[];
    dropdown?: {
      enabled?: number;
      maxItems?: number;
    };
    enforceWhitelist?: boolean;
  }

  export default class Tagify {
    public value: TagifyTagData[];
    public settings: TagifySettings;
    constructor(element: HTMLInputElement, settings?: TagifySettings);
    loadOriginalValues(value: string[] | string): void;
    on(eventName: string, callback: () => void): void;
    destroy(): void;
  }
}
