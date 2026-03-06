import session from "express-session";
import type { Express, RequestHandler } from "express";
import connectPg from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { authStorage } from "./storage";
import { companies } from "@shared/models/auth";
import { db } from "../../db";
import { eq } from "drizzle-orm";

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000;
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
    ttl: sessionTtl,
    tableName: "sessions",
    errorLog: (err: Error) => {
      console.error("Session store error:", err.message);
    },
  });
  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: "auto" as any,
      maxAge: sessionTtl,
    },
  });
  return (req: any, res: any, next: any) => {
    sessionMiddleware(req, res, (err: any) => {
      if (err) {
        console.error("Session middleware error:", err.message);
        if (req.path.startsWith("/api")) {
          return res.status(500).json({ message: "Session error" });
        }
      }
      next();
    });
  };
}

declare module "express-session" {
  interface SessionData {
    userId: string;
    viewingCompanyId?: string | null;
  }
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());

  app.get("/api/auth/invite/:token", async (req, res) => {
    try {
      const user = await authStorage.getUserByInviteToken(req.params.token);
      if (!user) {
        return res.status(404).json({ message: "This invitation link is invalid." });
      }
      if (user.status === "active") {
        return res.status(400).json({ message: "This account has already been registered. Please log in." });
      }
      if (user.inviteExpiresAt && new Date() > user.inviteExpiresAt) {
        return res.status(400).json({ message: "This invitation has expired. Please ask your administrator to resend." });
      }
      const [company] = await db.select().from(companies).where(
        eq(companies.id, user.companyId)
      );
      res.json({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        companyName: company?.name || "Unknown",
      });
    } catch (error) {
      console.error("Invite lookup error:", error);
      res.status(500).json({ message: "Failed to look up invitation" });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { inviteToken, password, confirmPassword } = req.body;

      if (inviteToken) {
        if (!password || password.length < 8) {
          return res.status(400).json({ message: "Password must be at least 8 characters" });
        }
        if (password !== confirmPassword) {
          return res.status(400).json({ message: "Passwords do not match" });
        }
        const user = await authStorage.getUserByInviteToken(inviteToken);
        if (!user) {
          return res.status(404).json({ message: "This invitation link is invalid." });
        }
        if (user.status === "active") {
          return res.status(400).json({ message: "This account has already been registered. Please log in." });
        }
        if (user.inviteExpiresAt && new Date() > user.inviteExpiresAt) {
          return res.status(400).json({ message: "This invitation has expired. Please ask your administrator to resend." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const updatedUser = await authStorage.updateUser(user.id, {
          password: hashedPassword,
          status: "active",
          registeredAt: new Date(),
          inviteToken: null,
        });

        const { password: _, ...safeUser } = updatedUser;
        return res.status(201).json({ message: "Registration complete. Please log in.", user: safeUser });
      }

      const { email, firstName, lastName } = req.body;

      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      if (password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }

      const existing = await authStorage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "An account with this email already exists" });
      }

      return res.status(403).json({ message: "Self-registration is not available. Users must be invited by an administrator." });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const user = await authStorage.getUserByEmail(email);
      if (!user || !user.password) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      if (user.status === "deactivated") {
        return res.status(401).json({ message: "Your account has been deactivated. Contact your administrator." });
      }

      if (user.status === "invited") {
        return res.status(401).json({ message: "Please complete your registration using the invitation link sent to your email." });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      await authStorage.updateUser(user.id, { lastLoginAt: new Date() });

      req.session.userId = user.id;
      const { password: _, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.clearCookie("connect.sid");
      res.json({ message: "Logged out" });
    });
  });

  app.post("/api/auth/switch-company", async (req: any, res) => {
    try {
      if (!req.session?.userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      const user = await authStorage.getUser(req.session.userId);
      if (!user || user.role !== "superadmin") {
        return res.status(403).json({ message: "Only SuperAdmin can switch companies" });
      }
      const { companyId } = req.body;
      req.session.viewingCompanyId = companyId || null;
      res.json({ viewingCompanyId: req.session.viewingCompanyId });
    } catch (error) {
      console.error("Switch company error:", error);
      res.status(500).json({ message: "Failed to switch company" });
    }
  });
}

export const isAuthenticated: RequestHandler = async (req: any, res, next) => {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const user = await authStorage.getUser(req.session.userId);
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (user.status !== "active") {
    req.session.destroy(() => {});
    return res.status(401).json({ message: "Your account has been deactivated." });
  }

  (req as any).user = user;
  next();
};

export { registerAuthRoutes } from "./routes";
