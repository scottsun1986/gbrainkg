/**
 * 并发流的注册表。
 *
 * 每条正在生成的回答按会话 id（或尚未分配 id 的草稿键）登记在此。用单一
 * `streaming` 布尔 + `[streaming]` effect 启动流时，第二条流的启动信号与第一
 * 条相同而被 React 丢弃，fetch 根本没发出——用户新建的会话因此不出现在列表
 * 里。注册表没有这个合并点：每次启动都登记一个独立键。
 */

export interface StreamRunLike {
  convId: string | null;
  controller: AbortController;
  flush: (done?: boolean) => void;
  title: string;
}

export type RunMap = Map<string, StreamRunLike>;

/** 新会话在服务端分配 id 前的临时键。 */
export function draftKey(seq: number): string {
  return `draft:${seq}`;
}

export function registerRun(runs: RunMap, seq: number, run: StreamRunLike): { key: string; draft: boolean } {
  const draft = run.convId === null;
  const key = draft ? draftKey(seq) : (run.convId as string);
  runs.set(key, run);
  return { key, draft };
}

/**
 * 草稿流拿到服务端 id 后换键。返回 false 表示该键已不属于本流
 * （用户可能已切走并重开），此时不应再改写视图归属。
 */
export function rekeyRun(runs: RunMap, fromKey: string, assignedId: string): boolean {
  const run = runs.get(fromKey);
  if (!run) return false;
  runs.delete(fromKey);
  run.convId = assignedId;
  runs.set(assignedId, run);
  return true;
}

export function unregisterRun(runs: RunMap, key: string, run: StreamRunLike): boolean {
  // 只摘除自己那条：并发的其他流不能被误清。
  if (runs.get(key) !== run) return false;
  runs.delete(key);
  return true;
}

/**
 * 本流是否仍拥有当前视图。
 *
 * @param viewKey      当前视图归属的键；null 表示空白的新会话视图
 * @param draftRunKey  当前持有空白视图的草稿流键
 * @param convId       本流已分配的服务端会话 id，未分配为 null
 * @param currentKey   本流当前登记的键
 */
export function runOwnsView(viewKey: string | null, draftRunKey: string | null, convId: string | null, currentKey: string): boolean {
  if (viewKey === null) return convId === null && draftRunKey === currentKey;
  return viewKey === currentKey || viewKey === convId;
}