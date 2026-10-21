// React bindings (imported as "onebase/react"). Same hook names as convex/react.

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { FunctionArgs, FunctionReference, FunctionReturnType, OptionalRestArgs } from "../api";
import { getFunctionName } from "../api";
import { OnebaseClient, type QueryResult } from "./index";

export * from "./index";

const ClientContext = createContext<OnebaseClient | null>(null);

export function OnebaseProvider(props: { client: OnebaseClient; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

export function useOnebase(): OnebaseClient {
  const client = useContext(ClientContext);
  if (!client) {
    throw new Error("No onebase client found. Wrap your app in <OnebaseProvider client={new OnebaseClient(url)}>.");
  }
  return client;
}

/** Live query result; `undefined` while loading. Pass "skip" to not subscribe. Errors throw to the nearest error boundary. */
export function useQuery<Q extends FunctionReference<"query">>(
  query: Q | string,
  ...args: keyof FunctionArgs<Q> extends never ? [args?: FunctionArgs<Q> | "skip"] : [args: FunctionArgs<Q> | "skip"]
): FunctionReturnType<Q> | undefined {
  const client = useOnebase();
  const a = args[0];
  const skip = a === "skip";
  const path = getFunctionName(query);
  const argsKey = skip ? "skip" : JSON.stringify(a ?? {});

  const subscribe = useCallback(
    (onChange: () => void) => (skip ? () => {} : client.subscribe(path, JSON.parse(argsKey), onChange)),
    [client, path, argsKey, skip],
  );
  const getSnapshot = useCallback(
    (): QueryResult | null => (skip ? null : client.localQueryResult(path, JSON.parse(argsKey))),
    [client, path, argsKey, skip],
  );
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!result) return undefined;
  if (!result.ok) throw result.error;
  return result.value as FunctionReturnType<Q>;
}

export function useMutation<M extends FunctionReference<"mutation">>(mutation: M | string) {
  const client = useOnebase();
  return useCallback(
    (...args: OptionalRestArgs<M>): Promise<FunctionReturnType<M>> => client.mutation(mutation as any, ...(args as [any])) as any,
    [client, getFunctionName(mutation)],
  );
}

export function useAction<A extends FunctionReference<"action">>(action: A | string) {
  const client = useOnebase();
  return useCallback(
    (...args: OptionalRestArgs<A>): Promise<FunctionReturnType<A>> => client.action(action as any, ...(args as [any])) as any,
    [client, getFunctionName(action)],
  );
}

export function useConnectionState() {
  const client = useOnebase();
  return useSyncExternalStore(
    (cb) => client.onConnectionChange(cb),
    () => client.connectionState,
  );
}

type PaginatedItem<Q> = FunctionReturnType<Q> extends { page: (infer T)[] } ? T : never;
type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

/**
 * Live paginated list. The query must take `paginationOpts` and return `.paginate(...)`.
 * Each loaded page stays reactive; earlier pages are pinned to their end cursor so pages never overlap.
 */
export function usePaginatedQuery<Q extends FunctionReference<"query">>(
  query: Q | string,
  args: Omit<FunctionArgs<Q>, "paginationOpts"> | "skip",
  options: { initialNumItems: number },
): { results: PaginatedItem<Q>[]; status: PaginationStatus; isLoading: boolean; loadMore: (numItems: number) => void } {
  const client = useOnebase();
  const path = getFunctionName(query);
  const argsKey = args === "skip" ? "skip" : JSON.stringify(args);
  type Page = { cursor: string | null; numItems: number; endCursor?: string };
  const [pages, setPages] = useState<Page[]>([]);
  const [results, setResults] = useState<Record<number, { page: unknown[]; isDone: boolean; continueCursor: string }>>({});

  // Reset when the query or its args change.
  useEffect(() => {
    setPages(argsKey === "skip" ? [] : [{ cursor: null, numItems: options.initialNumItems }]);
    setResults({});
  }, [path, argsKey]);

  useEffect(() => {
    if (argsKey === "skip") return;
    const base = JSON.parse(argsKey);
    const unsubs = pages.map((p, i) =>
      client.subscribe(path, { ...base, paginationOpts: { numItems: p.numItems, cursor: p.cursor, endCursor: p.endCursor } }, (r) => {
        if (!r.ok) return console.error(r.error);
        setResults((prev) => ({ ...prev, [i]: r.value as any }));
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [client, path, argsKey, JSON.stringify(pages)]);

  const loaded = pages.map((_, i) => results[i]);
  const last = loaded[loaded.length - 1];
  const status: PaginationStatus =
    pages.length === 0 || !loaded[0] ? "LoadingFirstPage" : !last ? "LoadingMore" : last.isDone ? "Exhausted" : "CanLoadMore";

  const loadMore = useCallback(
    (numItems: number) => {
      const lastIndex = pages.length - 1;
      const lastResult = results[lastIndex];
      if (!lastResult || lastResult.isDone) return;
      setPages((prev) => [
        ...prev.slice(0, lastIndex),
        { ...prev[lastIndex]!, endCursor: lastResult.continueCursor },
        { cursor: lastResult.continueCursor, numItems },
      ]);
    },
    [pages, results],
  );

  const flat = useMemo(() => loaded.flatMap((r) => (r ? r.page : [])) as PaginatedItem<Q>[], [results, pages]);
  return { results: flat, status, isLoading: status === "LoadingFirstPage" || status === "LoadingMore", loadMore };
}

/** Aliases so code written for Convex ports by changing the import path. */
export { OnebaseProvider as ConvexProvider, OnebaseClient as ConvexReactClient };
