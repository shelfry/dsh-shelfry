import { useSyncExternalStore } from "react";

/**
 * 收藏：存在本机浏览器里，没有后端。
 *
 * 只存条目 id 数组 —— 条目内容仍从静态产物读，收藏不会因为数据刷新而变旧。
 * 新收藏放在最前，收藏页按这个顺序展示；多个组件通过同一份快照同步。
 */

const KEY = "dsh:favs:v1";
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

let ids: string[] = read();
let idSet = new Set(ids);

function commit(next: string[]): void {
  ids = next;
  idSet = new Set(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不下也不影响本次会话里的收藏 */
  }
  listeners.forEach((fn) => fn());
}

export function toggleFavorite(id: string): void {
  commit(idSet.has(id) ? ids.filter((v) => v !== id) : [id, ...ids]);
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const readIds = (): string[] => ids;

export function useFavorites(): {
  ids: string[];
  has: (id: string) => boolean;
  toggle: (id: string) => void;
} {
  const list = useSyncExternalStore(subscribe, readIds, readIds);
  return {
    ids: list,
    has: (id) => idSet.has(id),
    toggle: toggleFavorite,
  };
}
