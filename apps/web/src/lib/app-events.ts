/** Typed listeners for the prototype's window CustomEvent bus. */

export function emitToast(detail: string): void {
  window.dispatchEvent(new CustomEvent('app-toast', { detail }));
}

export interface UndoableDetail {
  message?: string;
  undoLabel?: string;
  undo?: (() => void) | null;
}

export function emitUndoable(detail: UndoableDetail | string): void {
  window.dispatchEvent(new CustomEvent('app-undoable', { detail }));
}

export function emitDataRefresh(): void {
  window.dispatchEvent(new CustomEvent('app-data-refresh'));
}

export function emitAdminDataUpdated(detail: unknown): void {
  window.dispatchEvent(new CustomEvent('app-admin-data-updated', { detail }));
}

export function emitOpenConversation(conversationId: string): void {
  window.dispatchEvent(new CustomEvent('app-open-conversation', { detail: conversationId }));
}

export function emitNewChat(): void {
  window.dispatchEvent(new CustomEvent('app-new-chat'));
}

export function emitNewKb(): void {
  window.dispatchEvent(new CustomEvent('app-new-kb'));
}

export function emitFocusUpload(): void {
  window.dispatchEvent(new CustomEvent('app-focus-upload'));
}

export function onWindowEvent<T = unknown>(
  type: string,
  handler: (detail: T) => void,
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<T>).detail);
  };
  window.addEventListener(type, listener);
  return () => window.removeEventListener(type, listener);
}
