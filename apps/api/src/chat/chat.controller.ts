import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Delete,
  Get,
  MessageEvent,
  Req,
  Res,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatRunService } from "./chat-run.service";
import { Observable } from "rxjs";
import { Response } from "express";
import { AuthService } from "../auth/auth.service";
import { getPrismaClient } from "../prisma";
import { AuthGuard } from "../auth/auth.guard";
import { getRequestContext } from '../observability/request-context';
import { parseAsOf } from '../retrieval/as-of';
import { withStrictOutputPermit } from '../permission/strict-output-permit';
import { authorizationEnforced, AuthorizationSnapshot } from '../permission/authorization-revision';
import { TableEvidenceService } from '../retrieval/table-evidence.service';

@UseGuards(AuthGuard)
@Controller("api/v1/chat")
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly authService: AuthService,
    private readonly chatRunService: ChatRunService,
  ) {}

  private readonly prisma = getPrismaClient();

  @Get("memory")
  async recallMemory(@Req() req: any, @Query("query") query?: string, @Query("limit") rawLimit?: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const limit = Math.max(1, Math.min(Number(rawLimit || 20) || 20, 100));
    return this.chatService.recallPersonalFacts(userId, query, limit);
  }

  @Post("memory")
  async rememberMemory(@Req() req: any, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const fact = String(body?.fact || "").trim();
    if (!fact) throw new BadRequestException("fact is required.");
    return this.chatService.rememberPersonalFact(userId, fact, typeof body?.entity === "string" ? body.entity : undefined);
  }

  @Delete("memory/:id")
  async forgetMemory(@Req() req: any, @Param("id") id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    return this.chatService.forgetPersonalFact(userId, id);
  }

  @Post("memory/context-pack")
  async loadMemoryContext(@Req() req: any, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const entities = String(body?.entities || "").trim();
    if (!entities) throw new BadRequestException("entities is required.");
    return this.chatService.personalContextPack(userId, entities, typeof body?.session_id === "string" ? body.session_id : undefined);
  }

  @Post("search")
  async searchKnowledge(
    @Req() req: any,
    @Body() body: { query: string; kb_scope?: string[]; limit?: number; asOf?: string },
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    if (getRequestContext()) { getRequestContext()!.asOf = parseAsOf(body?.asOf); getRequestContext()!.asOfExplicit = body?.asOf != null; }
    const query = String(body?.query || "").trim();
    if (!query) throw new BadRequestException("query is required.");
    const limit = Math.max(1, Math.min(Number(body?.limit || 10) || 10, 50));
    return this.chatService.searchKnowledgeForAgent(userId, query, body?.kb_scope, limit);
  }

  @Post('table-aggregate')
  async aggregateTable(@Req() req: any, @Body() body: { documentId: string; versionId: string; tableId?: string; operation?: 'count'|'sum'|'min'|'max'|'avg'; column?: number }) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(body?.documentId || '') || !uuid.test(body?.versionId || '')) throw new BadRequestException('documentId and versionId are required UUIDs');
    return new TableEvidenceService().execute(await this.authService.userIdFromRequest(req), body);
  }

  @Post("completions")
  async streamCompletions(
    @Body() body: any,
    @Req() req: any,
    @Res() response: Response,
  ): Promise<void> {
    const strictOutput = process.env.KNOWLEDGE_STRICT_OUTPUT === '1';
    if (strictOutput && !authorizationEnforced()) throw new BadRequestException('Strict output requires authorization enforcement');
    const userId = await this.authService.userIdFromRequest(req);
    if (getRequestContext()) { getRequestContext()!.asOf = parseAsOf(body?.asOf); getRequestContext()!.asOfExplicit = body?.asOf != null; }
    // express.json only populates req.body on a matching content-type, so a
    // request without a JSON body yields undefined — destructuring it threw
    // a TypeError and surfaced as a 500. Treat it as a bad request instead.
    if (!body || typeof body !== "object") {
      throw new BadRequestException("Request body is required.");
    }
    const { message, kb_scope } = body;
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage)
      throw new BadRequestException("Message is required.");
    if (normalizedMessage.length > 10_000)
      throw new BadRequestException("Message is too long.");
    if (Array.isArray(kb_scope) && kb_scope.length > 100)
      throw new BadRequestException("Knowledge-base scope is too large.");
    // Requested scope must be a subset of the caller's visible knowledge
    // bases; otherwise reject with 403 before any stream is opened.
    await this.chatService.assertRequestedScopeAuthorized(userId, kb_scope);
    let conversation = body.conversation_id
      ? await this.prisma.conversation.findFirst({
          where: { id: body.conversation_id, userId },
        })
      : null;
    if (body.conversation_id && !conversation)
      throw new NotFoundException("Conversation not found.");
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          userId,
          title: normalizedMessage.slice(0, 120),
          kbScope: kb_scope || undefined,
        },
      });
    }
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: normalizedMessage,
      },
    });

    const requestStartedAt = Date.now();
    // Non-streaming callers get a run id up front and poll it; streaming callers
    // never see one. Empty string means "no run", which is what keeps the
    // finalize path free of run bookkeeping for the SSE case.
    let runId = "";

    // Non-streaming mode: answer the POST immediately with a run id and let the
    // client poll. The pipeline below is unchanged — it still runs through the
    // same observable and the same finalize that persists the message — this
    // only changes who receives the bytes and when.
    const wantsJson = body?.stream === false
      || String(req.headers?.accept || '').includes('application/json');

    if (wantsJson) {
      const run = await this.chatRunService.start(conversation.id, userId);
      runId = run.runId;
    } else {
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      response.write(
        `data: ${JSON.stringify({ type: "conversation", conversation_id: conversation.id })}\n\n`,
      );
    }

    let authorizationSnapshot: AuthorizationSnapshot | undefined;
    const stream$: Observable<MessageEvent> =
      await this.chatService.handleChatStream(
        userId,
        normalizedMessage,
        kb_scope,
        conversation.id,
        {
          onAuthorization: snapshot => { authorizationSnapshot = snapshot; },
          // Empty for SSE callers; set for the non-streaming run so stage
          // progress is recorded on the row the client polls.
          runId: runId || undefined,
        },
      );
    let answer = "";
    let errorContent = "";
    let traceId = "";
    let totalTokens = 0;
    let dependencyManifest: any = null;
    const citations: any[] = [];
    const traceNodes = new Map<string, any>();
    let finalizePromise: Promise<void> | null = null;
    const buffered: string[] = [];
    let bufferedBytes = 0;
    const writeEvent = (data: any) => {
      if (!response.writableEnded) {
        const event = `data: ${JSON.stringify(data)}\n\n`;
        if (strictOutput) {
          bufferedBytes += Buffer.byteLength(event);
          if (bufferedBytes > 8 * 1024 * 1024) throw new Error('Strict output buffer capacity exceeded');
          buffered.push(event);
        } else response.write(event);
      }
    };
    const upsertPersistenceTrace = (status: string, summary: string) => {
      const previous = traceNodes.get("message_persistence");
      const now = new Date();
      const startedAt = previous?.startedAt || now.toISOString();
      const node = {
        id: "message_persistence",
        name: "回答与诊断链路落库",
        status,
        startedAt,
        ...(status !== "running"
          ? {
              finishedAt: now.toISOString(),
              durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
            }
          : {}),
        summary,
      };
      traceNodes.set(node.id, node);
      writeEvent({ type: "trace", schema_version: 1, trace_id: traceId, node });
    };
    const finalize = () => {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async () => {
        const content = answer || errorContent || "本次问答未生成可保存的回答。";
        upsertPersistenceTrace("running", "正在保存回答、引用和处理链路");
        let messageId: string | undefined;
        try {
          const created = await this.prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "assistant",
              content,
              citationsSummary: citations,
              dependencyManifest: dependencyManifest || undefined,
              processingTrace: [...traceNodes.values()],
              latencyMs: Date.now() - requestStartedAt,
            },
          });
          messageId = created.id;
          const citationRows = citations
            .map((item: any) => item?.timeline_entry || {})
            .filter((item: any) => item.document_id && item.snippet)
            .map((item: any) => ({
              messageId: created.id,
              documentId: item.document_id,
              kbId: item.source_kb || null,
              snippet: String(item.snippet).slice(0, 12_000),
            }));
          if (citationRows.length > 0) {
            await this.prisma.citation.createMany({ data: citationRows });
          }
          upsertPersistenceTrace("success", "回答、引用和处理链路已保存");
          await this.prisma.message.update({
            where: { id: created.id },
            data: { processingTrace: [...traceNodes.values()] },
          });
          // A poll only learns the answer exists once the row does, so the run
          // is closed here rather than on `complete`: closing earlier would let
          // a client fetch a message that is not written yet.
          if (runId && messageId && !errorContent) await this.chatRunService.complete(runId, messageId);
        } catch (error: any) {
          console.error("Failed to persist assistant message:", error);
          upsertPersistenceTrace(
            "failed",
            `保存失败：${String(error?.message || error || "未知错误").slice(0, 300)}`,
          );
          if (runId) await this.chatRunService.fail(runId, `保存失败：${String(error?.message || error).slice(0, 300)}`);
        } finally {
          if (runId && errorContent && !messageId) await this.chatRunService.fail(runId, errorContent);
          writeEvent({
            type: "done",
            message_id: messageId,
            total_tokens: totalTokens,
            latency_ms: Date.now() - requestStartedAt,
            trace_id: traceId,
          });
          if (runId) {
            // The POST already returned; the client learns the outcome by
            // polling the run. Nothing more to write on this response.
            if (!response.writableEnded && !response.destroyed) response.end();
            return;
          }
          if (strictOutput && !errorContent && authorizationSnapshot) {
            try {
              await withStrictOutputPermit(userId, authorizationSnapshot, async () => {
                await new Promise<void>((resolve, reject) => {
                  const cleanup = () => { clearTimeout(timer); response.removeListener('error', onError); };
                  const onError = (error: Error) => { cleanup(); reject(error); };
                  const timer = setTimeout(() => { cleanup(); response.destroy(); reject(new Error('Strict transport drain timed out')); }, 5000);
                  response.once('error', onError);
                  response.end(buffered.join(''), () => { cleanup(); resolve(); });
                });
              });
            } catch (error: any) {
              if (!response.writableEnded && !response.destroyed) response.end(`data: ${JSON.stringify({ type: 'error', content: error.message })}\n\n`);
            }
          } else if (!response.writableEnded) {
            response.end(strictOutput ? `data: ${JSON.stringify({ type: 'error', content: errorContent || 'Authorization unavailable' })}\n\n` : undefined);
          }
        }
      })();
      return finalizePromise;
    };
    const subscription = stream$.subscribe({
      next: (event) => {
        const data: any = event.data;
        // Accumulate unconditionally: a non-streaming run has already sent its
        // 201 and closed the response, but the pipeline still has to collect
        // the answer that finalize persists. Only the wire write is conditional.
        if (data?.type === "delta") answer += String(data.content || "");
        if (data?.type === "citation") citations.push(data);
        if (data?.type === "error") errorContent = String(data.content || "问答处理失败");
        if (data?.type === "trace" && data.node?.id) {
          traceId = String(data.trace_id || traceId);
          traceNodes.set(data.node.id, data.node);
        }
        if (data?.type === "done") {
          totalTokens = Number(data.total_tokens || 0);
          dependencyManifest = data.dependency_manifest || null;
          return;
        }
        if (!response.writableEnded) writeEvent(event.data);
      },
      error: (error) => {
        // A non-streaming run's response is already closed, but the failure
        // still has to be recorded on the run and persisted as the answer.
        if (response.writableEnded && !runId) return;
        if (error?.getStatus?.() === 403 || error?.getStatus?.() === 503) {
          answer = ''; citations.length = 0; traceNodes.clear(); dependencyManifest = null;
        }
        // Translate common internal errors into user-friendly messages.
        const rawMsg = String(error.message || "Chat failed");
        const isAbort = error?.name === "AbortError" || /abort/i.test(rawMsg);
        const friendlyMsg = isAbort
          ? "知识检索超时，在您可访问的知识库范围内未找到相关内容。请确认您是否有该知识所属知识库的访问权限。"
          : `问答处理失败：${rawMsg}`;
        errorContent = friendlyMsg;
        const now = new Date().toISOString();
        const node = {
          id: "request_failure",
          name: "问答处理",
          status: "failed",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          summary: friendlyMsg.slice(0, 300),
        };
        traceNodes.set(node.id, node);
        writeEvent({ type: "trace", schema_version: 1, trace_id: traceId, node });
        writeEvent({ type: "error", content: errorContent });
        void finalize();
      },
      complete: () => {
        // RxJS 不会等待 async complete 回调，统一由 finalize 收口并在
        // 消息真正落库后再向浏览器发送 done。
        void finalize();
      },
    });
    if (runId) {
      // 201 + the run: the answer itself is fetched from GET /chat/runs/:runId
      // once it reports completed, so this response carries only identity.
      response.status(201).json({ conversationId: conversation.id, runId, status: "running" });
      // Do not tie the run to this response: closing it would abort generation
      // through the observable teardown, and the client is expected to navigate
      // away long before the answer is ready.
      return;
    }
    req.on("close", () => subscription.unsubscribe());
  }

  /**
   * Poll a non-streaming run. Returns the stage while it is in flight and, once
   * completed, the full answer with its citations and trace — the same payload
   * the SSE stream would have delivered, minus the per-token frames.
   */
  @Get("runs/:runId")
  async getRun(@Req() req: any, @Param("runId") runId: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const run = await this.chatRunService.get(userId, runId);
    // Polling is the client's liveness proof: it renews the lease that stops a
    // run whose tab was closed outright from burning the full deadline.
    if (run.status === 'running') this.chatRunService.touch(runId);
    return run;
  }

  /** Best-effort cancel. Only the instance that started the run can abort it. */
  @Post("runs/:runId/cancel")
  async cancelRun(@Req() req: any, @Param("runId") runId: string) {
    const userId = await this.authService.userIdFromRequest(req);
    // Read first: an unknown or foreign run must 404 rather than report success.
    const run = await this.chatRunService.get(userId, runId);
    if (run.status !== 'running') return { runId, cancelled: false, alreadyFinished: true };
    const aborted = this.chatRunService.cancel(runId);
    if (aborted) await this.chatRunService.fail(runId, '用户已停止生成。');
    // `cancelled: false` here means the run belongs to the other instance, whose
    // AbortController is process-local. The client must say so rather than imply
    // the stop took effect; the run's own deadline still ends it.
    return { runId, cancelled: aborted, alreadyFinished: false };
  }
}
