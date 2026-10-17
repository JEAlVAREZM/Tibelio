import "server-only";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import { transaction, tokenHash } from "../../../shared/server/store";
import type { ActorContext } from "./authorization";
import { AppError } from "../../../shared/server/app-error";

export const SESSION_COOKIE = "tibelio_session";
export const passwordSchema = z.string().min(12).max(128);
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
export const hashPassword = (password: string) =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
let dummy: Promise<string> | undefined;
export async function login(input: unknown) {
  const data = z
    .object({ username: usernameSchema, password: z.string().min(1).max(128) })
    .strict()
    .parse(input);
  const candidate = await transaction(
    null,
    async (db) => {
      const limit = await db.query<{ allowed: boolean }>(
        "select app_private.throttle($1) allowed",
        [tokenHash(data.username)],
      );
      if (!limit.rows[0]?.allowed) return { limited: true as const };
      const found = await db.query<{ id: string; password_hash: string }>(
        "select * from app_private.login_candidate($1)",
        [data.username],
      );
      return { limited: false as const, user: found.rows[0] };
    },
    true,
  );
  if (candidate.limited) throw new AppError("RATE_LIMITED");
  dummy ??= hashPassword(randomBytes(32).toString("hex"));
  const valid = await argon2.verify(
    candidate.user?.password_hash ?? (await dummy),
    data.password,
  );
  if (!valid || !candidate.user) throw new AppError("UNAUTHENTICATED");
  const user = candidate.user;
  const token = randomBytes(32).toString("hex");
  const opened = await transaction(
    null,
    async (db) => {
      const result = await db.query<{ opened: boolean }>(
        "select app_private.open_session($1,$2,$3) opened",
        [user.id, user.password_hash, tokenHash(token)],
      );
      return result.rows[0]?.opened;
    },
    true,
  );
  if (!opened) throw new AppError("UNAUTHENTICATED");
  return token;
}
export async function sessionActor(
  token: string | null,
): Promise<ActorContext | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return transaction(
    token,
    async (db) =>
      (
        await db.query<{ actor: ActorContext | null }>(
          "select app_private.actor() actor",
        )
      ).rows[0]?.actor ?? null,
  );
}
export async function logout(token: string | null) {
  if (token)
    await transaction(
      token,
      async (db) => {
        await db.query("select app_private.close_session()");
      },
      true,
    );
}
