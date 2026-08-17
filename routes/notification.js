// Route file for a customer's notifications.
//
// Mounted at /notification behind `authentication` (see app.js).
//
// In-app only — see the model comment in schema.prisma. The shop writes these;
// the customer reads and clears them.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";

// Everything the customer has been told, newest first, plus an unread count for
// the header badge.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { playerid: playerId },
        orderBy: { created: "desc" },
        take: 50,
      }),
      prisma.notification.count({
        where: { playerid: playerId, readat: null },
      }),
    ]);

    return res.status(200).json({ unread, items });
  })
);

// Mark everything read. There is no per-item interaction worth preserving —
// the customer either has seen the list or has not.
router.post(
  "/read",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    const { count } = await prisma.notification.updateMany({
      where: { playerid: playerId, readat: null },
      data: { readat: Math.round(Date.now() / 1000) },
    });

    return res.status(200).json({ read: count });
  })
);

// Dismiss one outright.
router.delete(
  "/:notificationId",
  [check("notificationId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const id = parseInt(req.params.notificationId, 10);

    // Scoped to the owner so one customer cannot delete another's.
    const item = await prisma.notification.findFirst({
      where: { id, playerid: playerId },
    });
    if (!item) {
      return res.status(404).json({ message: messages.NOTIFICATION_NOT_FOUND });
    }

    await prisma.notification.delete({ where: { id } });
    return res.status(200).json({ message: messages.NOTIFICATION_REMOVED });
  })
);

export default router;
