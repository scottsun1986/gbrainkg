import { ChatTraceRecorder } from "./chat-trace";

describe("ChatTraceRecorder", () => {
  it("emits running and terminal node updates without secrets", () => {
    const events: any[] = [];
    const recorder = new ChatTraceRecorder({
      closed: false,
      next: (event: any) => events.push(event.data),
    } as any);

    recorder.start("retrieval", "GBrain 检索", "开始", {
      sourceCount: 2,
      apiKey: "must-not-leak",
    });
    recorder.finish("retrieval", "success", "命中 3 条", { candidateCount: 3 });

    expect(events).toHaveLength(2);
    expect(events[0].node.status).toBe("running");
    expect(events[1].node.status).toBe("success");
    expect(events[1].node.details).toEqual({ sourceCount: 2, candidateCount: 3 });
    expect(events[1].trace_id).toBe(events[0].trace_id);
  });
});
