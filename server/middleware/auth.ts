import type { RequestHandler } from "express";
import { authStorage } from "../replit_integrations/auth/storage";

declare module "express-session" {
  interface SessionData {
    userId: string;
    viewingCompanyId?: string | null;
  }
}

export const authenticate: RequestHandler = async (req: any, res, next) => {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const user = await authStorage.getUser(req.session.userId);
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (user.status !== "active") {
    req.session.destroy(() => {});
    return res.status(401).json({ message: "Your account has been deactivated. Contact your administrator." });
  }

  req.user = user;
  next();
};

export function authorize(...allowedRoles: string[]): RequestHandler {
  return (req: any, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

export const companyFilter: RequestHandler = (req: any, res, next) => {
  if (req.user.role === "superadmin") {
    req.companyId = req.session?.viewingCompanyId || null;
  } else {
    req.companyId = req.user.companyId;
  }
  next();
};
