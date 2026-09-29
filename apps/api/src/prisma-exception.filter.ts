import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Centralised Prisma exception mapping.
 *
 * Route params that reach a Prisma `findUnique({ where: { id } })` without a
 * UUID format check made Prisma throw "Inconsistent column data: Error
 * creating UUID …" — surfaced to clients as a naked 500 (measured across
 * /kbs/:kbId, /documents/:docId/retry, /kbs/personal/:id with ids like
 * "nonexistent-kb-id"). Legitimate clients only ever send malformed ids while
 * probing, and the correct answer there is 400/404, never a stack-traced 500.
 *
 * Mapping (mainstream mapping of Prisma known errors):
 *   - malformed uuid / inconsistent column data → 400 Bad Request
 *   - P2025 (record not found)                  → 404 Not Found
 *   - P2002 (unique constraint)                 → 409 Conflict
 *   - P2024 / pool timeout                      → 503 Service Unavailable
 *     (a pool-exhausted create returned a raw 500 under concurrent load)
 * Everything else rethrows untouched so Nest's default handling applies.
 */
@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    if (exception instanceof HttpException) {
      // Framework exceptions (BadRequest/NotFound/…) keep their native shape.
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.mapKnownError(exception);
      if (mapped) {
        this.logMapped(response, exception, mapped.status, mapped.message);
        response.status(mapped.status).json({
          statusCode: mapped.status,
          message: mapped.message,
          error: mapped.error,
        });
        return;
      }
    }

    const msg = exception instanceof Error ? `${exception.message}` : "";
    if (/Error creating UUID|Inconsistent column data/i.test(msg)) {
      this.logMapped(response, exception, 400, "Invalid resource id format.");
      response.status(400).json({
        statusCode: 400,
        message: "Invalid resource id format.",
        error: "Bad Request",
      });
      return;
    }
    if (/Timed out fetching a new connection from the connection pool/i.test(msg)) {
      this.logMapped(response, exception, 503, "Database is busy, retry shortly.");
      response.status(503).json({
        statusCode: 503,
        message: "Database is busy, please retry shortly.",
        error: "Service Unavailable",
      });
      return;
    }

    // Unknown error: keep Nest's default 500 shape and log with stack.
    this.logger.error(
      `Unhandled exception on ${response?.req?.originalUrl || "?"}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      message: "Internal server error",
    });
  }

  private mapKnownError(
    e: Prisma.PrismaClientKnownRequestError,
  ): { status: number; message: string; error: string } | null {
    if (e.code === "P2025") {
      return { status: HttpStatus.NOT_FOUND, message: "Resource not found.", error: "Not Found" };
    }
    if (e.code === "P2002") {
      return { status: HttpStatus.CONFLICT, message: "Resource already exists.", error: "Conflict" };
    }
    if (e.code === "P2024") {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: "Database is busy, please retry shortly.",
        error: "Service Unavailable",
      };
    }
    const text = `${e.message}`;
    if (/Error creating UUID|Inconsistent column data/i.test(text)) {
      return { status: HttpStatus.BAD_REQUEST, message: "Invalid resource id format.", error: "Bad Request" };
    }
    return null;
  }

  private logMapped(_response: any, exception: unknown, status: number, message: string) {
    this.logger.warn(
      `Mapped error -> ${status} (${message}): ${exception instanceof Error ? exception.message : String(exception).slice(0, 120)}`,
    );
  }
}
