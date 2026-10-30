import type { ChatPushEvent } from "./contract";
import type { Device, SendResult } from "../push/firebase";

export interface ChatGateway {
  beginRun(): void;
  assertCapacity?(count?: number): void;
  devices(uid: string): Promise<Device[]>;
  sendChat(event: ChatPushEvent, device: Device): Promise<SendResult>;
  removeInvalid(uid: string, device: Device): Promise<void>;
}
export interface ChatDeviceReceipt { state: "accepted" | "invalid" | "retry"; attempts: number; nextAttempt: number }
export interface ChatDelivery {
  event: ChatPushEvent;
  devices: Record<string, ChatDeviceReceipt>;
  attempts: number;
  done: boolean;
}
export async function deliverChat(state: ChatDelivery, gateway: ChatGateway, save: () => Promise<void>, now = Date.now()): Promise<number | null> {
  if (state.done) return null;
  const expires = Date.parse(state.event.createdAt) + 86400000;
  if (now >= expires || state.attempts >= 20) { state.done = true; await save(); return null; }
  state.attempts++;
  await save();
  gateway.beginRun();
  let devices: Device[];
  try { devices = await gateway.devices(state.event.recipientUid); }
  catch { return now + Math.min(300000, 1000 * 2 ** Math.min(8, state.attempts)); }
  if (!devices.length) { state.done = true; await save(); return null; }
  let next: number | null = null;
  for (const device of devices) {
    const deviceKey = "device:" + device.id;
    const receipt = state.devices[deviceKey];
    if (receipt && receipt.state !== "retry") continue;
    if (receipt && receipt.attempts >= 8) continue;
    if (receipt && receipt.nextAttempt > now) { next = Math.min(next ?? Infinity, receipt.nextAttempt); continue; }
    try { gateway.assertCapacity?.(2); } catch { return Math.min(next ?? Infinity, now + 1000); }
    const attempt: ChatDeviceReceipt = { state: "retry", attempts: (receipt?.attempts ?? 0) + 1, nextAttempt: now + 30000 };
    state.devices[deviceKey] = attempt;
    await save();
    try {
      const result = await gateway.sendChat(state.event, device);
      if (result === "accepted" || result === "invalid") {
        attempt.state = result;
        await save();
        if (result === "invalid") {
          try { await gateway.removeInvalid(state.event.recipientUid, device); } catch { /* O token será reavaliado no próximo evento. */ }
        }
        continue;
      }
      const delay = typeof result === "object" ? result.retryAfterMs : Math.min(300000, 1000 * 2 ** attempt.attempts);
      attempt.nextAttempt = now + Math.max(1000, delay);
    } catch {
      attempt.nextAttempt = now + Math.min(300000, 1000 * 2 ** attempt.attempts);
    }
    await save();
    if (attempt.attempts < 8) next = Math.min(next ?? Infinity, attempt.nextAttempt);
  }
  if (next === null) { state.done = true; await save(); }
  return next === null ? null : Math.min(next, expires);
}
