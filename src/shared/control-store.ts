import type { Env, NotificationStore } from "./types";

export async function openNotificationStore(env: Env): Promise<NotificationStore> {
  const control = env.NOTIFICATION_CONTROL;
  if (!control) throw new Error("Configure NOTIFICATION_CONTROL");
  return { ensureIndexes: async () => {}, insertOnce: notification => control.deliver(notification), close: async () => {} };
}
