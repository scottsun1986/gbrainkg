import { ServiceUnavailableException } from '@nestjs/common';
import { nonEvidenceManifest } from '../permission/evidence-dependencies';

/** REST and MCP consume the same authoritative terminal answer. */
export class ExternalChatEventReducer {
  answer = '';
  citations: any[] = [];
  citationEnvelopes: any[] = [];
  readonly traceNodes = new Map<string, any>();
  dependencyManifest: unknown;
  failure: string | null = null;
  done = false;

  consume(event: any): any | null {
    const item = event?.data ?? event;
    if (!item || this.failure) return null;
    switch (item.type) {
      case 'delta': case 'token':
        this.answer += String(item.content ?? item.token ?? '');
        return { type: 'delta', content: String(item.content ?? item.token ?? '') };
      case 'replace':
        this.answer = String(item.content ?? '');
        return { type: 'replace', content: this.answer };
      case 'citation':
        this.citations.push(item.timeline_entry);
        this.citationEnvelopes.push({ type: 'citation', index: item.index,
          topic_slug: item.topic_slug ?? item.timeline_entry?.doc_title, timeline_entry: item.timeline_entry });
        return { type: 'citation', citation: item.timeline_entry };
      case 'citations':
        this.citations = Array.isArray(item.citations) ? item.citations : [];
        this.citationEnvelopes = this.citations.map(c => c?.timeline_entry ? c
          : { type: 'citation', topic_slug: c?.topic_slug ?? c?.doc_title, timeline_entry: c });
        return { type: 'citations', citations: this.citations };
      case 'trace':
        if (item.node?.id) this.traceNodes.set(String(item.node.id), item.node);
        return { type: 'trace', node: item.node };
      case 'done':
        this.done = true;
        this.dependencyManifest = item.answer_kind === 'refusal' && !this.citationEnvelopes.length
          ? nonEvidenceManifest('refusal') : item.dependency_manifest;
        return null;
      case 'error':
        this.fail();
        return { type: 'error', error: this.failure };
      default: return null;
    }
  }

  fail(): void {
    this.failure = '本次问答处理失败，请重试。';
    this.answer = '';
    this.citations = [];
    this.citationEnvelopes = [];
    this.traceNodes.clear();
    this.dependencyManifest = nonEvidenceManifest('failure');
  }

  assertSuccessful(): void {
    if (this.failure || !this.done || !this.answer.trim()) {
      this.fail();
      throw new ServiceUnavailableException(this.failure);
    }
  }
}
