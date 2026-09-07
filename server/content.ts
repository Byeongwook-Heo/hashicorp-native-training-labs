import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  type AuthContext,
  type AuthService,
  getAuthContext,
} from "./auth.js";
import {
  readCatalog,
  readCatalogYaml,
  writeCatalogYaml,
} from "./catalog.js";

const MAX_CATALOG_YAML_BYTES = 256_000;
const MAX_CATALOG_JSON_BYTES = 260_000;

type HttpError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
  code?: string;
};

function asyncHandler(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function requestBytes(request: Request) {
  const value = request.get("content-length");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isStorageError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "EACCES" ||
    code === "ENOENT" ||
    code === "ENOSPC" ||
    code === "EROFS" ||
    code === "EMFILE" ||
    code === "ENFILE"
  );
}

function safeErrorKind(error: unknown) {
  if (isStorageError(error)) {
    return (error as NodeJS.ErrnoException).code ?? "STORAGE_ERROR";
  }
  if (error instanceof Error) return error.name.slice(0, 80);
  return "UnknownError";
}

async function appendCatalogAudit(
  auth: AuthService,
  context: AuthContext,
  action: string,
  metadata?: Record<string, unknown>,
) {
  await auth.store.appendAudit({
    action,
    actorUserId: context.user.id,
    targetType: "catalog",
    targetId: "course-catalog",
    metadata,
  });
}

function requireJson(request: Request, response: Response, next: NextFunction) {
  if (!request.is("application/json")) {
    response.status(415).json({
      error: "Content-Type은 application/json이어야 합니다.",
      code: "UNSUPPORTED_CONTENT_TYPE",
    });
    return;
  }
  const declaredBytes = requestBytes(request);
  if (declaredBytes !== undefined && declaredBytes > MAX_CATALOG_JSON_BYTES) {
    response.status(413).json({
      error: "요청 본문이 너무 큽니다.",
      code: "PAYLOAD_TOO_LARGE",
    });
    return;
  }
  next();
}

function catalogErrorHandler(
  error: HttpError,
  _request: Request,
  response: Response,
  next: NextFunction,
) {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error.status === 413 || error.statusCode === 413 || error.type === "entity.too.large") {
    response.status(413).json({
      error: "요청 본문이 너무 큽니다.",
      code: "PAYLOAD_TOO_LARGE",
    });
    return;
  }
  if (
    error instanceof SyntaxError ||
    error.status === 400 ||
    error.type === "entity.parse.failed"
  ) {
    response.status(400).json({
      error: "올바른 JSON 본문을 전송해 주세요.",
      code: "INVALID_JSON",
    });
    return;
  }
  response.status(500).json({
    error: "콘텐츠 요청을 처리할 수 없습니다.",
    code: "CONTENT_INTERNAL_ERROR",
  });
}

export function createContentRouter(auth: AuthService): express.Router {
  const router = express.Router();

  router.use(auth.authenticate);

  router.get(
    "/catalog",
    auth.requireAuth,
    asyncHandler(async (_request, response) => {
      try {
        const catalog = await readCatalog();
        response.setHeader("Cache-Control", "private, no-store");
        response.json({ catalog });
      } catch {
        response.status(503).json({
          error: "과정 카탈로그를 불러올 수 없습니다.",
          code: "CATALOG_UNAVAILABLE",
        });
      }
    }),
  );

  router.get(
    "/admin/catalog",
    auth.requireRole("admin", "instructor"),
    asyncHandler(async (_request, response) => {
      try {
        const result = await readCatalogYaml();
        response.setHeader("Cache-Control", "private, no-store");
        response.json(result);
      } catch {
        response.status(503).json({
          error: "과정 카탈로그를 불러올 수 없습니다.",
          code: "CATALOG_UNAVAILABLE",
        });
      }
    }),
  );

  router.put(
    "/admin/catalog",
    auth.requireRole("admin"),
    requireJson,
    express.json({ limit: MAX_CATALOG_JSON_BYTES, strict: true }),
    asyncHandler(async (request, response) => {
      const context = getAuthContext(response)!;
      const yaml =
        request.body &&
        typeof request.body === "object" &&
        !Array.isArray(request.body) &&
        typeof request.body.yaml === "string"
          ? request.body.yaml
          : undefined;
      const yamlBytes =
        yaml === undefined ? undefined : Buffer.byteLength(yaml, "utf8");
      if (yaml === undefined || yamlBytes! > MAX_CATALOG_YAML_BYTES) {
        await appendCatalogAudit(auth, context, "catalog.update_rejected", {
          reason:
            yaml === undefined ? "INVALID_BODY" : "YAML_PAYLOAD_TOO_LARGE",
          yamlBytes,
        });
        response.status(yaml === undefined ? 400 : 413).json({
          error:
            yaml === undefined
              ? "본문에 yaml 문자열이 필요합니다."
              : "카탈로그 YAML은 256KB 이하여야 합니다.",
          code:
            yaml === undefined ? "INVALID_CATALOG_BODY" : "PAYLOAD_TOO_LARGE",
        });
        return;
      }

      await appendCatalogAudit(auth, context, "catalog.update_requested", {
        yamlBytes,
      });
      try {
        const catalog = await writeCatalogYaml(yaml);
        await appendCatalogAudit(auth, context, "catalog.updated", {
          version: catalog.version,
          trackCount: catalog.tracks.length,
          yamlBytes,
        }).catch(() => undefined);
        response.setHeader("Cache-Control", "no-store");
        response.json({ catalog });
      } catch (error) {
        await appendCatalogAudit(auth, context, "catalog.update_failed", {
          errorKind: safeErrorKind(error),
          yamlBytes,
        }).catch(() => undefined);
        if (isStorageError(error)) {
          response.status(503).json({
            error: "카탈로그를 저장할 수 없습니다.",
            code: "CATALOG_STORAGE_UNAVAILABLE",
          });
          return;
        }
        response.status(400).json({
          error: "카탈로그 YAML 형식과 필드 값을 확인해 주세요.",
          code: "INVALID_CATALOG",
        });
      }
    }),
  );

  router.use(catalogErrorHandler as ErrorRequestHandler);
  return router;
}
