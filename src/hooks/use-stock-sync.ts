import { useEffect, useCallback, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════
   BROADCASTCHANNEL STOCK SYNC
   Keeps stock data synchronized across multiple browser tabs
   using the BroadcastChannel API. When one tab completes a sale
   or adjusts inventory, all other tabs are notified in real time.
   ═══════════════════════════════════════════════════════════════ */

export interface StockChangeEvent {
  type: "stock_change";
  productId: string;
  warehouseId: string;
  newQuantity: number;
  timestamp: number;
}

export interface CartSyncEvent {
  type: "cart_sync";
  cartId: string;
  items: Array<{ productId: string; quantity: number }>;
  timestamp: number;
}

export interface RefreshRequest {
  type: "refresh_request";
  source: string;
  timestamp: number;
}

export type SyncEvent = StockChangeEvent | CartSyncEvent | RefreshRequest;

const CHANNEL_NAME = "elite-pos-stock-sync";

let channelInstance: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!channelInstance) {
    channelInstance = new BroadcastChannel(CHANNEL_NAME);
  }
  return channelInstance;
}

/**
 * Broadcast a stock change event to all other tabs.
 */
export function broadcastStockChange(
  productId: string,
  warehouseId: string,
  newQuantity: number
): void {
  try {
    const channel = getChannel();
    const event: StockChangeEvent = {
      type: "stock_change",
      productId,
      warehouseId,
      newQuantity,
      timestamp: Date.now(),
    };
    channel.postMessage(event);
  } catch {
    // BroadcastChannel not supported — silent fallback
  }
}

/**
 * Broadcast a refresh request to all other tabs.
 */
export function broadcastRefreshRequest(source: string): void {
  try {
    const channel = getChannel();
    const event: RefreshRequest = {
      type: "refresh_request",
      source,
      timestamp: Date.now(),
    };
    channel.postMessage(event);
  } catch {
    // Silent fallback
  }
}

/**
 * Hook to listen for cross-tab stock synchronization events.
 *
 * @param onStockChange - Called when another tab reports a stock change
 * @param onRefreshRequest - Called when another tab requests a refresh
 * @param tabId - Unique ID for this tab (to avoid processing own messages)
 */
export function useStockSync(
  onStockChange?: (event: StockChangeEvent) => void,
  onRefreshRequest?: (event: RefreshRequest) => void,
  tabId?: string
) {
  const tabIdRef = useRef(tabId ?? `tab-${Math.random().toString(36).slice(2, 8)}-${Date.now()}`);

  const handleMessage = useCallback(
    (event: MessageEvent<SyncEvent>) => {
      // Ignore messages from self
      if (event.data?.type === "refresh_request" && event.data.source === tabIdRef.current) {
        return;
      }

      switch (event.data?.type) {
        case "stock_change":
          onStockChange?.(event.data as StockChangeEvent);
          break;
        case "refresh_request":
          onRefreshRequest?.(event.data as RefreshRequest);
          break;
      }
    },
    [onStockChange, onRefreshRequest]
  );

  useEffect(() => {
    try {
      const channel = getChannel();
      channel.addEventListener("message", handleMessage);
      return () => {
        channel.removeEventListener("message", handleMessage);
      };
    } catch {
      // BroadcastChannel not supported
    }
  }, [handleMessage]);

  return {
    broadcastStockChange: useCallback(
      (productId: string, warehouseId: string, newQuantity: number) => {
        broadcastStockChange(productId, warehouseId, newQuantity);
      },
      []
    ),
    broadcastRefreshRequest: useCallback(
      (source: string) => {
        broadcastRefreshRequest(source || tabIdRef.current);
      },
      []
    ),
  };
}
