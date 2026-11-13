import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Covers a queued check's wait plus its steps; the reaper waits the same before settling a run (D034 §3). */
export const RUN_KEY_TTL_SECONDS = 45 * 60;

export interface RunKeyRedisClient {
  set(key: string, value: string, opts: { ex: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

function redisKey(runId: string): string {
  return `grounnel:runkey:${runId}`;
}

/** Holds an own provider key, encrypted, only while its queued check runs. Never in a job payload, a row or a log (D034 §3). */
export class RunKeyVault {
  private readonly aesKey: Buffer;

  constructor(private readonly redis: RunKeyRedisClient, secret: string) {
    // Hashing fixes the length at 32 bytes whatever the configured secret's length.
    this.aesKey = createHash("sha256").update(secret, "utf8").digest();
  }

  async put(runId: string, providerKey: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.aesKey, iv);
    // The run id is authenticated data, so a ciphertext copied under another run's name won't decrypt.
    cipher.setAAD(Buffer.from(runId, "utf8"));
    const body = Buffer.concat([cipher.update(providerKey, "utf8"), cipher.final()]);
    const sealed = [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
    await this.redis.set(redisKey(runId), sealed, { ex: RUN_KEY_TTL_SECONDS });
  }

  /** Null when the key expired or was already deleted. */
  async get(runId: string): Promise<string | null> {
    const sealed = await this.redis.get(redisKey(runId));
    if (!sealed) return null;
    const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.aesKey, iv!);
    decipher.setAAD(Buffer.from(runId, "utf8"));
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
  }

  async delete(runId: string): Promise<void> {
    await this.redis.del(redisKey(runId));
  }
}
