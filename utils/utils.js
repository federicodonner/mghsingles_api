import fetch from "cross-fetch";
import { randomInt } from "crypto";

// Returns a cryptographically random string of the specified length.
//
// This is the session credential (the bearer token), so the randomness MUST
// come from a CSPRNG. It used to use `Math.random()`, whose V8 xorshift128+
// state is recoverable from a handful of outputs — an attacker who saw a few
// tokens could predict the next, forging sessions. `crypto.randomInt` draws
// from the OS CSPRNG with no modulo bias.
export function generateToken(
  length,
  universe = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
) {
  var result = "";
  for (var i = 0; i < length; i++) {
    result += universe.charAt(randomInt(universe.length));
  }
  return result;
}

// Access external URL
export async function accessURL(url) {
  var fetchPromise = await fetch(url, { method: "GET", timeout: 30000 });
  return fetchPromise;
}
