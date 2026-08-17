// Wraps an async route handler so a rejected promise reaches Express's error
// middleware instead of becoming an unhandled rejection.
//
// Without this, a throwing handler in Express 4 never responds: the request
// hangs forever and Node kills the process on the unhandled rejection. Every
// async handler in routes/ must be wrapped.
export function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default asyncHandler;

// Returns req.playerId, throwing if it is missing.
//
// Prisma treats `undefined` in a `where` clause as "filter not supplied", so
// `where: { id, playerid: undefined }` silently matches on `id` alone. If an
// auth middleware ever fails to run, an ownership check written that way turns
// into no check at all. Always read the id through this.
export function requirePlayerId(req) {
  const playerId = req.playerId;
  if (typeof playerId !== "number") {
    const err = new Error("playerId missing — route is not behind authentication");
    err.status = 401;
    throw err;
  }
  return playerId;
}
