import { errors, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { AppError } from "./errors.js";

const ALGORITHM = "HS256";
const MIN_SECRET_LENGTH = 32;

const Claims = z.object({
  sub: z.string().min(1).max(100),
  role: z.enum(["user", "admin"]),
});

export type AuthUser = { id: string; role: "user" | "admin" };

// Fail at startup rather than run with a guessable signing key.
export function loadAuthSecret(value = process.env.AUTH_SECRET): Uint8Array {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters`);
  }
  return new TextEncoder().encode(value);
}

export async function signToken(secret: Uint8Array, userId: string, role: AuthUser["role"] = "user") {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

export async function verifyToken(secret: Uint8Array, authorization: string | undefined): Promise<AuthUser> {
  const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new AppError(401, "UNAUTHORIZED", "Missing bearer token");

  let payload;
  try {
    // Pinning the algorithm stops a token from choosing a weaker one, such as "none".
    ({ payload } = await jwtVerify(token, secret, { algorithms: [ALGORITHM] }));
  } catch (err) {
    if (err instanceof errors.JOSEError) throw new AppError(401, "UNAUTHORIZED", "Invalid or expired token");
    throw err;
  }

  const claims = Claims.safeParse(payload);
  if (!claims.success) throw new AppError(401, "UNAUTHORIZED", "Token is missing required claims");
  return { id: claims.data.sub, role: claims.data.role };
}
