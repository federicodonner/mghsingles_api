import fetch from "cross-fetch";

// Returns a random string of the specified length
export function generateToken(
  length,
  universe = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
) {
  var result = "";
  for (var i = 0; i < length; i++) {
    result += universe.charAt(Math.floor(Math.random() * universe.length));
  }
  return result;
}

// Access external URL
export async function accessURL(url) {
  var fetchPromise = await fetch(url, { method: "GET", timeout: 30000 });
  return fetchPromise;
}
