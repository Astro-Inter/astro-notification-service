// Reserva os inteiros menores para IDs numéricos já existentes no banco.
export const notificationIdFloor = 2 ** 52;

export async function notificationId(key: string): Promise<number> {
  if (!key) throw new Error("Identidade da notificação ausente");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`astro.notification.v1\0${key}`)));
  let value = digest[0]! & 0x0f;
  for (let index = 1; index < 7; index++) value = value * 256 + digest[index]!;
  return notificationIdFloor + value;
}
