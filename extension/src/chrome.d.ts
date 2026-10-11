/**
 * The slice of the `chrome` API this extension uses, declared by hand.
 * Small on purpose: anything not listed here is not used.
 */
declare namespace chrome {
  namespace runtime {
    function getManifest(): { version: string; version_name?: string };
    function reload(): void;
    function sendMessage(message: unknown): Promise<any>;
    const onMessage: {
      addListener(cb: (message: unknown, sender: unknown, reply: (response: unknown) => void) => boolean | void): void;
    };
    const onStartup: { addListener(cb: () => void): void };
    const onInstalled: { addListener(cb: () => void): void };
  }

  namespace storage {
    const local: {
      get(key: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    const session: {
      get(key: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
    const onChanged: { addListener(cb: (changes: Record<string, unknown>) => void): void };
  }

  namespace alarms {
    function create(name: string, info: { periodInMinutes: number }): void;
    const onAlarm: { addListener(cb: () => void): void };
  }

  namespace tabs {
    type Tab = { id?: number; windowId: number; url?: string; active: boolean; lastAccessed?: number; status?: string };
    function query(info: { url?: string[]; windowId?: number }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(props: { url: string; active: boolean; windowId?: number }): Promise<Tab>;
    function update(tabId: number, props: { url?: string; active?: boolean; autoDiscardable?: boolean }): Promise<Tab>;
  }

  namespace windows {
    function create(
      info: { url?: string; focused: boolean; state?: "minimized" },
    ): Promise<{ tabs?: tabs.Tab[] }>;
    function getAll(filter: { windowTypes: "normal"[] }): Promise<{ id?: number; focused: boolean }[]>;
    function update(windowId: number, info: { focused?: boolean }): Promise<unknown>;
  }

  namespace scripting {
    function executeScript<A extends unknown[]>(injection: {
      target: { tabId: number };
      world?: "ISOLATED" | "MAIN";
      files?: string[];
      func?: (...args: A) => unknown;
      args?: A;
    }): Promise<{ result?: any }[]>;
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  }

  namespace permissions {
    function request(info: { origins: string[] }): Promise<boolean>;
  }
}
